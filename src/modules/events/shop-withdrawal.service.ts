import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { DeploymentService } from '../../common/services/deployment.service';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { ShopWithdrawal } from '../../database/entities/shop-withdrawal.entity';
import { EmailService } from '../email/email.service';
import {
  type PublicLegalInfo,
  toPublicLegalInfo,
} from '../organizations/legal/legal-settings.util';
import type { CreateShopWithdrawalDto } from './dto/shop-withdrawal.dto';

export interface WithdrawalInfo {
  event: { id: string; name: string };
  organizationName: string;
  legal: PublicLegalInfo;
}

export interface WithdrawalReceipt {
  /** Eingangszeitpunkt (ISO). */
  receivedAt: string;
  /** Kennung des Eingangs für Rückfragen. */
  reference: string;
}

/** Shop-Adresse fuer den Link in der Bestellbestaetigung. */
export function withdrawalUrl(shopBase: string, eventId: string): string {
  return `${shopBase.replace(/\/+$/, '')}/widerruf/${eventId}`;
}

/**
 * Elektronische Widerrufsfunktion fuer Shop-Bestellungen (§ 356a BGB).
 *
 * Nur wenn der Verein „Für Bestellungen besteht ein Widerrufsrecht“
 * eingeschaltet hat — fuer Speisen und Getraenke zu einer Veranstaltung
 * besteht in aller Regel keines (§ 312g Abs. 2 Nr. 2 und 9 BGB). Der
 * Widerruf geht an den Verein (er ist Vertragspartner), der Gast bekommt
 * sofort eine Eingangsbestaetigung mit Inhalt, Datum und Uhrzeit.
 *
 * Erreichbar auch nach dem Ende der Veranstaltung (die Widerrufsfrist
 * laeuft weiter); Missbrauchsschutz: Honeypot, Rate-Limit je IP.
 */
@Injectable()
export class ShopWithdrawalService {
  private readonly logger = new Logger(ShopWithdrawalService.name);

  constructor(
    @InjectRepository(ShopWithdrawal)
    private readonly withdrawals: Repository<ShopWithdrawal>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly deployment: DeploymentService,
  ) {}

  private notAvailable(): NotFoundException {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.WITHDRAWAL_NOT_AVAILABLE,
      message:
        'Für Bestellungen in diesem Shop ist keine Widerrufsfunktion eingerichtet.',
    });
  }

  private async load(
    eventId: string,
  ): Promise<{ event: Event; organization: Organization }> {
    const event = await this.events.findOne({
      where: { id: eventId },
    });
    if (!event || event.settings?.shop?.enabled === undefined) {
      throw this.notAvailable();
    }
    const organization = await this.organizations.findOne({
      where: { id: event.organizationId },
    });
    if (
      !organization ||
      organization.settings?.legal?.withdrawalRight !== true
    ) {
      throw this.notAvailable();
    }
    return { event, organization };
  }

  async info(eventId: string): Promise<WithdrawalInfo> {
    const { event, organization } = await this.load(eventId);
    return {
      event: { id: event.id, name: event.name },
      organizationName: organization.name,
      legal: toPublicLegalInfo(organization, this.deployment.platformLegal),
    };
  }

  async submit(
    eventId: string,
    dto: CreateShopWithdrawalDto,
  ): Promise<WithdrawalReceipt> {
    const { event, organization } = await this.load(eventId);

    if (dto.website?.trim()) {
      this.logger.debug('Widerruf verworfen: Honeypot-Feld befüllt');
      return { receivedAt: new Date().toISOString(), reference: '—' };
    }

    const email = dto.email.trim().toLowerCase();
    const orderReference = dto.orderNumber.trim();
    const orderId = await this.findOrder(event.id, orderReference, email);

    const saved = await this.withdrawals.save(
      this.withdrawals.create({
        organizationId: organization.id,
        eventId: event.id,
        orderId,
        orderReference,
        name: dto.name.trim(),
        email,
        message: dto.message?.trim() || null,
      }),
    );
    this.logger.log(
      `Widerruf ${saved.id} für Veranstaltung ${event.id} eingegangen (Bestellung ${orderId ? 'gefunden' : 'nicht zugeordnet'})`,
    );

    const content = {
      organizationName: organization.name,
      eventName: event.name,
      name: saved.name,
      email: saved.email,
      orderReference,
      message: saved.message,
      receivedAt: saved.receivedAt,
      reference: saved.id,
    };

    try {
      const sent = await this.emailService.sendShopWithdrawalConfirmation({
        to: email,
        ...content,
        replyTo: organization.settings?.legal?.contactEmail ?? null,
      });
      if (sent) {
        await this.withdrawals.update(
          { id: saved.id },
          { confirmationSentAt: new Date() },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Eingangsbestätigung (Widerruf ${saved.id}) nicht gesendet: ${(error as Error).message}`,
      );
    }

    try {
      const recipients = await this.clubRecipients(organization);
      let delivered = recipients.length > 0;
      for (const to of recipients) {
        const ok = await this.emailService.sendShopWithdrawalToClub({
          to,
          ...content,
          orderFound: !!orderId,
        });
        delivered = delivered && ok;
      }
      if (delivered) {
        await this.withdrawals.update(
          { id: saved.id },
          { clubNotifiedAt: new Date() },
        );
      } else {
        this.logger.warn(
          `Widerruf ${saved.id}: keine Empfängeradresse beim Verein erreicht`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Widerruf ${saved.id} nicht an den Verein gesendet: ${(error as Error).message}`,
      );
    }

    return {
      receivedAt: saved.receivedAt.toISOString(),
      reference: saved.id,
    };
  }

  /** Bestellung mit dieser Nummer und dieser E-Mail-Adresse im Shop. */
  private async findOrder(
    eventId: string,
    orderNumber: string,
    email: string,
  ): Promise<string | null> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT o.id
         FROM orders o
         JOIN shop_checkouts c ON c.order_id = o.id
        WHERE c.event_id = $1
          AND upper(o.order_number) = upper($2)
          AND lower(c.email) = $3
        LIMIT 1`,
      [eventId, orderNumber, email],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Der Verein: die Kontaktadresse aus den rechtlichen Angaben und die
   * Admins der Organisation (der Widerruf darf nicht im Postfach eines
   * Einzelnen liegen bleiben).
   */
  private async clubRecipients(organization: Organization): Promise<string[]> {
    const rows: { email: string }[] = await this.dataSource.query(
      `SELECT DISTINCT u.email FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'
          AND u.deleted_at IS NULL AND u.is_active = true`,
      [organization.id],
    );
    const contact = organization.settings?.legal?.contactEmail;
    return [
      ...new Set(
        [contact, ...rows.map((r) => r.email)]
          .filter((e): e is string => !!e)
          .map((e) => e.toLowerCase()),
      ),
    ];
  }
}
