import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Event, Organization } from '../../database/entities';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { EmailService } from '../email/email.service';
import { softwareFacts } from './legal-elster.service';
import { LegalService } from './legal.service';
import {
  emergencyPhoneTelUri,
  normalizeEmergencyPhone,
} from '../support/emergency-support';

/**
 * Buchungsbestaetigung an die Organisation nach einer Freischaltung
 * (Stripe bezahlt oder auf Rechnung bestellt): Leistung, Tage, Preis,
 * Zahlungsweg, die Fassungen von AGB und AVV und — bei Cloud-TSE — die
 * Angaben fuer die ELSTER-Mitteilung. Best effort: eine gescheiterte Mail
 * dreht keine Buchung zurueck.
 */
@Injectable()
export class BookingConfirmationService {
  private readonly logger = new Logger(BookingConfirmationService.name);

  constructor(
    @InjectRepository(TseUnit)
    private readonly tseUnits: Repository<TseUnit>,
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly legal: LegalService,
    private readonly configService: ConfigService,
  ) {}

  /** An wen: Rechnungs-E-Mail der Organisation, sonst alle Admins. */
  private async recipients(organization: Organization): Promise<string[]> {
    if (organization.billingEmail) return [organization.billingEmail];
    const rows: { email: string }[] = await this.dataSource.query(
      `SELECT u.email
         FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'`,
      [organization.id],
    );
    return [...new Set(rows.map((r) => r.email))];
  }

  async send(input: {
    event: Event;
    organization: Organization;
    paymentMethod: 'stripe' | 'invoice';
    amount: number;
    invoiceNumber?: string | null;
  }): Promise<void> {
    if (!this.legal.config.enabled) return;
    try {
      const { event, organization } = input;
      const unit = await this.tseUnits.findOne({
        where: { organizationId: organization.id, state: 'active' },
        order: { createdAt: 'DESC' },
      });
      const facts = softwareFacts(
        (key) => this.configService.get<string>(key),
        organization.id,
      );
      const withTse = event.tseIncluded === true || !!unit;
      const phone = normalizeEmergencyPhone(
        this.configService.get<string>('OPERATOR_EMERGENCY_PHONE'),
      );
      const emergencyPhone = phone
        ? { phone, telUri: emergencyPhoneTelUri(phone) }
        : null;
      const recipients = await this.recipients(organization);
      for (const to of recipients) {
        await this.emailService.sendEventBookingConfirmationEmail({
          to,
          organizationName: organization.name,
          eventName: event.name,
          startDate: event.startDate,
          endDate: event.endDate,
          timeZone: organization.settings?.timezone || 'Europe/Berlin',
          days: event.billedDays,
          tseIncluded: event.tseIncluded === true,
          amount: input.amount,
          currency: organization.settings?.currency || 'EUR',
          paymentMethod: input.paymentMethod,
          invoiceNumber: input.invoiceNumber ?? null,
          bookedAt: event.paidAt ?? new Date(),
          documents: this.legal.emailDocuments(),
          elster: withTse
            ? {
                softwareName: facts.software.name,
                manufacturer: facts.software.manufacturer,
                softwareVersion: facts.software.version,
                registerSerial: facts.register.serialNumber,
                tse: unit
                  ? {
                      serialNumber: unit.serialNumber,
                      certificationId: unit.certificationId,
                      certificateExpiresAt: unit.certificateExpiresAt,
                      activatedAt: unit.activatedAt,
                    }
                  : null,
              }
            : null,
          emergencyPhone,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Buchungsbestätigung für Event ${input.event.id} nicht gesendet: ${(error as Error).message}`,
      );
    }
  }
}
