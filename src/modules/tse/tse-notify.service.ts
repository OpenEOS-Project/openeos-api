import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { EmailService } from '../email/email.service';
import { GatewayService } from '../gateway/gateway.service';

export type TseNoticeKind =
  | 'outage'
  | 'creation_failed'
  | 'activated'
  | 'deactivated'
  | 'export_failed';

/**
 * Benachrichtigt die Admins einer Organisation (E-Mail) und Kassen
 * (Echtzeit). Fehler beim Senden werden nur protokolliert — eine
 * Benachrichtigung darf nie einen Verkauf oder Hintergrundlauf stoppen.
 */
@Injectable()
export class TseNotifyService {
  private readonly logger = new Logger(TseNotifyService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepository: Repository<UserOrganization>,
    private readonly emailService: EmailService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * GatewayService erst zur Laufzeit holen: das Gateway-Modul haengt
   * (ueber Geraete und Drucker) indirekt am TSE-Modul, ein Import hier
   * ergaebe einen Modulkreis.
   */
  private gateway(): GatewayService | null {
    try {
      return this.moduleRef.get(GatewayService, { strict: false });
    } catch {
      return null;
    }
  }

  /** Einstellungen geaendert (z. B. Bargeld jetzt erlaubt) → Kassen laden neu. */
  settingsChanged(organizationId: string): void {
    try {
      this.gateway()?.notifyOrganizationSettingsUpdated(organizationId);
    } catch (error) {
      this.logger.warn(`settings update not sent: ${(error as Error).message}`);
    }
  }

  statusChanged(
    organizationId: string,
    data: { state: string; outage: boolean; reason?: string | null },
  ): void {
    try {
      this.gateway()?.notifyTseStatusChanged(organizationId, data);
    } catch (error) {
      this.logger.warn(
        `tseStatusChanged not sent: ${(error as Error).message}`,
      );
    }
  }

  async notifyAdmins(
    organizationId: string,
    kind: TseNoticeKind,
    rows: [string, string][],
  ): Promise<void> {
    try {
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
        select: { id: true, name: true },
      });
      const memberships = await this.membershipRepository.find({
        where: { organizationId, role: OrganizationRole.ADMIN },
        relations: ['user'],
      });
      const recipients = [
        ...new Set(
          memberships
            .map((m) => m.user?.email)
            .filter((email): email is string => !!email),
        ),
      ];
      const text = NOTICE_TEXT[kind];
      for (const to of recipients) {
        await this.emailService.sendTseNoticeEmail({
          to,
          subject: text.subject,
          intro: text.intro(organization?.name ?? ''),
          rows,
          todo: text.todo,
        });
      }
    } catch (error) {
      this.logger.warn(
        `TSE notice ${kind} for ${organizationId} not sent: ${(error as Error).message}`,
      );
    }
  }
}

const NOTICE_TEXT: Record<
  TseNoticeKind,
  {
    subject: string;
    intro: (org: string) => string;
    todo: { title: string; text: string } | null;
  }
> = {
  outage: {
    subject: 'Cloud-TSE ausgefallen',
    intro: (org) =>
      `Die Cloud-TSE${org ? ` von ${org}` : ''} hat einen Vorgang nicht signiert. Ihr könnt weiter kassieren: Die Bons tragen den Vermerk „TSE ausgefallen“, und OpenEOS protokolliert den Ausfall automatisch.`,
    todo: {
      title: 'Was du tun solltest',
      text: 'Prüfe die Internetverbindung der Kassen. Hält der Ausfall an, melde dich beim Support. Sobald die TSE wieder signiert, endet der Ausfall im Protokoll von selbst.',
    },
  },
  creation_failed: {
    subject: 'Cloud-TSE konnte nicht angelegt werden',
    intro: (org) =>
      `Die Cloud-TSE${org ? ` für ${org}` : ''} konnte nicht angelegt werden. OpenEOS versucht es automatisch erneut.`,
    todo: {
      title: 'Was du tun solltest',
      text: 'Ohne aktive TSE ist Bargeld in Deutschland gesperrt; Karte und Online-Zahlung gehen weiter. Bleibt der Fehler, melde dich beim Support.',
    },
  },
  activated: {
    subject: 'Cloud-TSE ist aktiv',
    intro: (org) =>
      `Die Cloud-TSE${org ? ` von ${org}` : ''} ist eingerichtet. Ab jetzt wird jeder Kassenvorgang signiert, und die Bons tragen die TSE-Angaben mit QR-Code.`,
    todo: null,
  },
  deactivated: {
    subject: 'Cloud-TSE deaktiviert',
    intro: (org) =>
      `Die Cloud-TSE${org ? ` von ${org}` : ''} ist außer Betrieb. OpenEOS holt den abschließenden Export automatisch ab und bewahrt ihn auf.`,
    todo: {
      title: 'Gut zu wissen',
      text: 'Ohne aktive TSE ist Bargeld in Deutschland gesperrt. Die Exporte findest du weiter unter Integrationen → Cloud-TSE.',
    },
  },
  export_failed: {
    subject: 'TSE-Export nicht abgeholt',
    intro: (org) =>
      `Der Export der Cloud-TSE${org ? ` von ${org}` : ''} konnte nicht abgeholt werden. OpenEOS versucht es automatisch erneut.`,
    todo: null,
  },
};
