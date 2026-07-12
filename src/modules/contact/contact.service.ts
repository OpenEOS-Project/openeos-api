import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { TelegramSupportService } from '../support/telegram-support.service';
import { CreateContactRequestDto } from './dto';

// Anfragen mit weniger Zeit zwischen Formular-Laden und Absenden gelten als
// automatisiert (Bots füllen Formulare i.d.R. sofort aus).
const MIN_FILL_TIME_MS = 3000;

const TYPE_LABELS: Record<CreateContactRequestDto['type'], string> = {
  demo: 'Demo-Anfrage',
  contact: 'Kontaktanfrage',
  hardware: 'Hardware-Miete',
  gateway: 'Kassen-Gateway',
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
