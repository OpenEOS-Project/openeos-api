import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Organization, User } from '../../../database/entities';
import {
  AdminAction,
  AdminAuditLog,
} from '../../../database/entities/admin-audit-log.entity';
import { OrganizationOperatingModeChange } from '../../../database/entities/organization-operating-mode-change.entity';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import {
  getOperatingMode,
  getOperatingModeSince,
  type OperatingMode,
} from '../../../common/utils/operating-mode.util';
import { OrganizationsService } from '../organizations.service';
import {
  buildCertificateContent,
  operatorFromEnv,
  renderCertificatePdf,
  type CertificateHistoryEntry,
} from './operating-mode-certificate';

export type OperatingModeHistoryEntry = Pick<
  OrganizationOperatingModeChange,
  'id' | 'createdAt' | 'fromMode' | 'toMode' | 'reason' | 'changedByName'
>;

export interface OperatingModeState {
  operatingMode: OperatingMode;
  operatingModeSince: string | null;
}

/**
 * Betriebsmodus „Nur Bestellen“ (siehe operating-mode.util.ts).
 *
 * Umschalten darf nur der Support (Super-Admin, Admin-Endpunkt) — nie die
 * Organisation selbst. Ein Bestellsystem ohne Kassenmodul ist nur dann
 * TSE-frei, wenn der Verein das Kassenmodul nicht selbst einschalten kann;
 * das belegt die Herstellerbescheinigung, die hier entsteht.
 */
@Injectable()
export class OperatingModeService {
  private readonly logger = new Logger(OperatingModeService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly dataSource: DataSource,
    private readonly organizationsService: OrganizationsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Schaltet den Modus um (nur Super-Admin; der Aufrufer prueft das per
   * SuperAdminGuard). Schalter, Verlauf und Admin-Protokoll in einer
   * Transaktion bei gesperrter Organisationszeile. Ohne Aenderung 400
   * OPERATING_MODE_UNCHANGED — jeder Verlaufseintrag soll eine echte
   * Umschaltung sein.
   *
   * Geschrieben wird gezielt per jsonb, damit maskierte Zugangsdaten und
   * alle anderen Einstellungen unberuehrt bleiben.
   */
  async setMode(
    organizationId: string,
    mode: OperatingMode,
    reason: string,
    admin: User,
    client: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<OperatingModeState> {
    const trimmedReason = reason.trim();
    return this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query<
        { settings: Record<string, unknown> | null }[]
      >(
        `SELECT settings FROM organizations
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [organizationId],
      );
      if (!row) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
          message: 'Organisation nicht gefunden',
        });
      }
      const from = getOperatingMode(row.settings);
      if (from === mode) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.OPERATING_MODE_UNCHANGED,
          message: 'Die Organisation ist bereits in diesem Betriebsmodus.',
          params: { mode },
        });
      }

      const changedAt = new Date();
      await manager.query(
        `UPDATE organizations
            SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [
          organizationId,
          JSON.stringify({
            operatingMode: mode,
            operatingModeSince: changedAt.toISOString(),
          }),
        ],
      );

      const name = [admin.firstName, admin.lastName].filter(Boolean).join(' ');
      await manager.insert(OrganizationOperatingModeChange, {
        organizationId,
        fromMode: from,
        toMode: mode,
        reason: trimmedReason,
        changedByUserId: admin.id,
        changedByName: (name ? `${name} (${admin.email})` : admin.email)?.slice(
          0,
          255,
        ),
        ipAddress: client.ipAddress?.slice(0, 45) ?? null,
        userAgent: client.userAgent?.slice(0, 500) ?? null,
        createdAt: changedAt,
      });
      await manager.insert(AdminAuditLog, {
        adminUserId: admin.id,
        organizationId,
        action: AdminAction.SET_OPERATING_MODE,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          before: { operatingMode: from },
          after: { operatingMode: mode },
        },
        reason: trimmedReason,
        ipAddress: (client.ipAddress || '0.0.0.0').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });

      this.logger.log(
        `Operating mode of organization ${organizationId} switched ${from} -> ${mode} by super admin ${admin.id}`,
      );

      return {
        operatingMode: mode,
        operatingModeSince: changedAt.toISOString(),
      };
    });
  }

  /** Verlauf, neueste zuerst. Ohne Pruefung — Aufrufer pruefen Zugriff. */
  history(organizationId: string): Promise<OperatingModeHistoryEntry[]> {
    return this.dataSource.getRepository(OrganizationOperatingModeChange).find({
      where: { organizationId },
      select: {
        id: true,
        createdAt: true,
        fromMode: true,
        toMode: true,
        reason: true,
        changedByName: true,
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /** Modus und Verlauf fuer Mitglieder der Organisation. */
  async getForMember(
    organizationId: string,
    user: User,
  ): Promise<OperatingModeState & { history: OperatingModeHistoryEntry[] }> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    return {
      operatingMode: getOperatingMode(organization.settings),
      operatingModeSince: getOperatingModeSince(organization.settings),
      // Wer im Support umgeschaltet hat, bleibt intern (Admin-Verlauf).
      history: (await this.history(organization.id)).map((h) => ({
        ...h,
        changedByName: 'OpenEOS-Support',
      })),
    };
  }

  /**
   * Herstellerbescheinigung als PDF (nur Admins der Organisation). Nur im
   * Modus `order_only` — im Kassenbetrieb gibt es nichts zu bescheinigen.
   */
  async certificatePdf(
    organizationId: string,
    user: User,
  ): Promise<{ pdf: Buffer; filename: string }> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );
    const since = getOperatingModeSince(organization.settings);
    if (getOperatingMode(organization.settings) !== 'order_only' || !since) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.CERTIFICATE_REQUIRES_ORDER_ONLY,
        message:
          'Die Bescheinigung gibt es nur im Betriebsmodus „Nur Bestellen“.',
      });
    }

    const history = await this.history(organization.id);
    const content = buildCertificateContent({
      organization: {
        id: organization.id,
        name: organization.name,
        address: organization.settings?.address ?? organization.billingAddress,
      },
      since: new Date(since),
      issuedAt: new Date(),
      version:
        process.env.APP_VERSION || process.env.npm_package_version || 'dev',
      operator: operatorFromEnv((key) => this.configService.get<string>(key)),
      timeZone: organization.settings?.timezone || 'Europe/Berlin',
      history: history.map(
        (h): CertificateHistoryEntry => ({
          at: new Date(h.createdAt),
          fromMode: h.fromMode,
          toMode: h.toMode,
          reason: h.reason,
        }),
      ),
    });
    const pdf = await renderCertificatePdf(content);
    const day = new Date().toISOString().slice(0, 10);
    return {
      pdf,
      filename: `openeos-herstellerbescheinigung-${organization.slug || organization.id}-${day}.pdf`,
    };
  }

  /** Fuer Admin-Seiten: Modus einer Organisation ohne Mitgliedschaft. */
  async stateOf(organizationId: string): Promise<OperatingModeState> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    return {
      operatingMode: getOperatingMode(organization?.settings),
      operatingModeSince: getOperatingModeSince(organization?.settings),
    };
  }
}
