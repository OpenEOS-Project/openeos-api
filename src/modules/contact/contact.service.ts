import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TelegramSupportService } from '../support/telegram-support.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ContactRequest } from '../../database/entities';
import { CreateContactRequestDto } from './dto';

// Anfragen mit weniger Zeit zwischen Formular-Laden und Absenden gelten als
// automatisiert (Bots füllen Formulare i.d.R. sofort aus).
const MIN_FILL_TIME_MS = 3000;

const TYPE_LABELS: Record<CreateContactRequestDto['type'], string> = {
  demo: 'Demo-Anfrage',
  contact: 'Kontaktanfrage',
  hardware: 'Hardware-Miete',
  gateway: 'Kassen-Gateway',
  feedback: 'Rückmeldung',
  feature: 'Funktionswunsch',
};

/**
 * Öffentlicher, nicht-authentifizierter Endpunkt für Demo-/Kontaktanfragen
 * von der Marketing-Website. Zustellung per E-Mail + Telegram, spam-geschützt
 * (Honeypot + Zeit-Gate + Rate-Limit).
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    @InjectRepository(ContactRequest)
    private readonly contactRequestRepository: Repository<ContactRequest>,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly telegramSupportService: TelegramSupportService,
  ) {}

  async submit(dto: CreateContactRequestDto): Promise<{ message: string }> {
    const successResponse = { message: 'Vielen Dank! Wir melden uns zeitnah.' };

    const website = dto.website?.trim();
    if (website) {
      this.logger.debug('Kontaktanfrage verworfen: Honeypot-Feld befüllt');
      return successResponse;
    }

    if (Date.now() - dto.startedAt < MIN_FILL_TIME_MS) {
      this.logger.debug('Kontaktanfrage verworfen: Formular zu schnell abgesendet');
      return successResponse;
    }

    const name = dto.name.trim();
    const email = dto.email.trim();
    const organization = dto.organization?.trim() || undefined;
    const message = dto.message.trim();
    const typeLabel = TYPE_LABELS[dto.type];

    /* Zuerst ablegen, dann benachrichtigen. Andersherum haenge die
       Zuschrift daran, dass eine Mail rausgeht — ist keine Adresse
       hinterlegt, war sie weg, waehrend der Absender eine Bestaetigung
       las. Schlaegt sogar das Speichern fehl, wird das laut protokolliert
       und der Versand trotzdem versucht. */
    let gespeichert: ContactRequest | null = null;
    try {
      gespeichert = await this.contactRequestRepository.save(
        this.contactRequestRepository.create({
          type: dto.type,
          name,
          email,
          organization: organization ?? null,
          message,
        }),
      );
    } catch (error) {
      this.logger.error(`Kontaktanfrage konnte nicht gespeichert werden: ${(error as Error).message}`);
    }

    try {
      const notifyEmail = await this.platformSettingsService.resolveNotificationTarget('contactRequest');
      if (notifyEmail) {
        await this.emailService.sendAdminContactRequestNotification({
          to: notifyEmail,
          type: dto.type,
          name,
          email,
          organization,
          message,
        });
        if (gespeichert) {
          await this.contactRequestRepository.update(
            { id: gespeichert.id },
            { notifiedAt: new Date() },
          );
        }
      } else {
        this.logger.warn(
          'Keine Empfängeradresse für Kontaktanfragen hinterlegt — die Zuschrift liegt nur in der Datenbank.',
        );
      }
    } catch (error) {
      this.logger.warn(`E-Mail-Benachrichtigung (Kontaktanfrage) fehlgeschlagen: ${(error as Error).message}`);
    }

    try {
      const text = `🌐 ${typeLabel} — nicht authentifiziert\n👤 ${name} <${email}>${organization ? `\n🏢 ${organization}` : ''}\n\n${message}`;
      await this.telegramSupportService.sendWebsiteInquiry(text);
    } catch (error) {
      this.logger.warn(`Telegram-Weiterleitung (Kontaktanfrage) fehlgeschlagen: ${(error as Error).message}`);
    }

    return successResponse;
  }
}
