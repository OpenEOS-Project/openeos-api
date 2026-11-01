import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { Organization, User } from '../../../database/entities';
import {
  AdminAction,
  AdminAuditLog,
} from '../../../database/entities/admin-audit-log.entity';
import { OrganizationCashPolicyChange } from '../../../database/entities/organization-cash-policy-change.entity';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import { normalizeCountry } from '../../../common/constants/countries';
import {
  cashPolicyView,
  resolveCashPolicy,
  type CashPolicy,
  type CashPolicyReason,
} from '../../../common/utils/cash-policy.util';
import { getOperatingMode } from '../../../common/utils/operating-mode.util';
import { OrganizationsService } from '../organizations.service';
import {
  operatorFromEnv,
  renderCertificatePdf,
} from '../operating-mode/operating-mode-certificate';
import { buildCashPolicyCertificateContent } from './cash-policy-certificate';
import {
  recordCashPolicyChange,
  writeCountry,
  type ClientInfo,
} from './cash-policy.writes';

export type CashPolicyHistoryItem = Pick<
  OrganizationCashPolicyChange,
  | 'id'
  | 'createdAt'
  | 'kind'
  | 'fromValue'
  | 'toValue'
  | 'reason'
  | 'bySupport'
  | 'changedByName'
>;

export interface CashPolicyState {
  country: string | null;
  cashPolicy: CashPolicy;
  cashPolicyLegacy: boolean;
  cashPolicyReason: CashPolicyReason;
}

function invalidCountry(): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.COUNTRY_INVALID,
    message: 'Bitte wähle ein Land aus der Liste.',
  });
}

/**
 * Land und Bargeld-Regel einer Organisation (cash-policy.util.ts).
 *
 * - Der Verein setzt das Land genau einmal, wenn noch keins hinterlegt ist
 *   (Bestandsorganisationen); neue Organisationen bringen es beim Anlegen
 *   mit. Danach aendert es nur der Support, mit Grund.
 * - Der Verein kann den Bestandsschutz einmalig aufgeben und auf
 *   „Deutschland ohne Bargeld“ wechseln; zurueck nur ueber den Support.
 * - Bescheinigung als PDF, solange Bargeld durch die Regel gesperrt ist.
 */
@Injectable()
export class CashPolicyService {
  private readonly logger = new Logger(CashPolicyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly organizationsService: OrganizationsService,
    private readonly configService: ConfigService,
  ) {}

  private async lockOrganization(
    manager: EntityManager,
    organizationId: string,
  ): Promise<{ country: string | null; cash_policy_legacy: boolean }> {
    const [row] = await manager.query<
      { country: string | null; cash_policy_legacy: boolean }[]
    >(
      `SELECT country, cash_policy_legacy FROM organizations
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
    return row;
  }

  private stateOfRow(row: {
    country: string | null;
    cash_policy_legacy: boolean;
  }): CashPolicyState {
    return cashPolicyView({
      country: row.country,
      cashPolicyLegacy: row.cash_policy_legacy,
    });
  }

  /** Verlauf, neueste zuerst. Ohne Pruefung — Aufrufer pruefen Zugriff. */
  history(organizationId: string): Promise<CashPolicyHistoryItem[]> {
    return this.dataSource.getRepository(OrganizationCashPolicyChange).find({
      where: { organizationId },
      select: {
        id: true,
        createdAt: true,
        kind: true,
        fromValue: true,
        toValue: true,
        reason: true,
        bySupport: true,
        changedByName: true,
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /** Zustand und Verlauf fuer Mitglieder der Organisation. */
  async getForMember(
    organizationId: string,
    user: User,
  ): Promise<
    CashPolicyState & {
      operatingMode: string;
      history: CashPolicyHistoryItem[];
    }
  > {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    return {
      ...cashPolicyView(organization),
      operatingMode: getOperatingMode(organization.settings),
      // Wer im Support geaendert hat, bleibt intern (Admin-Verlauf).
      history: (await this.history(organization.id)).map((h) => ({
        ...h,
        changedByName: h.bySupport ? 'OpenEOS-Support' : h.changedByName,
      })),
    };
  }

  /**
   * Land einmalig setzen (Admins der Organisation). Steht schon eins, 403
   * COUNTRY_ALREADY_SET — aendern kann es dann nur der Support.
   */
  async setCountryOnce(
    organizationId: string,
    country: string,
    user: User,
    client: ClientInfo = {},
  ): Promise<CashPolicyState> {
    const code = normalizeCountry(country);
    if (!code) throw invalidCountry();
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockOrganization(manager, organization.id);
      if (row.country) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.COUNTRY_ALREADY_SET,
          message:
            'Das Land deiner Organisation ist schon festgelegt. Ändern kann es nur der OpenEOS-Support.',
          params: { country: row.country },
        });
      }
      await writeCountry(manager, organization.id, code);
      await recordCashPolicyChange(manager, {
        organizationId: organization.id,
        kind: 'country',
        fromValue: null,
        toValue: code,
        user,
        client,
      });
      this.logger.log(
        `Country of organization ${organization.id} set to ${code} by user ${user.id}`,
      );
      return this.stateOfRow({ ...row, country: code });
    });
  }

  /**
   * Freiwilliger Wechsel einer Bestandsorganisation in Deutschland auf
   * „Deutschland ohne Bargeld“ (Admins). Nur in eine Richtung: zurueck
   * nur ueber den Support.
   */
  async adoptCountryPolicy(
    organizationId: string,
    user: User,
    client: ClientInfo = {},
  ): Promise<CashPolicyState> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockOrganization(manager, organization.id);
      if (!row.cash_policy_legacy) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.CASH_POLICY_ALREADY_ACTIVE,
          message: 'Für deine Organisation gilt die Regel deines Landes schon.',
        });
      }
      if (row.country !== 'DE') {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.CASH_POLICY_SWITCH_REQUIRES_DE,
          message:
            'Den Wechsel auf „Deutschland ohne Bargeld“ gibt es nur für Organisationen in Deutschland.',
          params: { country: row.country },
        });
      }
      await manager.query(
        `UPDATE organizations
            SET cash_policy_legacy = false, updated_at = now()
          WHERE id = $1`,
        [organization.id],
      );
      await recordCashPolicyChange(manager, {
        organizationId: organization.id,
        kind: 'policy',
        fromValue: 'legacy',
        toValue: 'country',
        reason: 'Freiwilliger Wechsel durch die Organisation',
        user,
        client,
      });
      this.logger.log(
        `Organization ${organization.id} switched to the DE cash policy by user ${user.id}`,
      );
      return this.stateOfRow({ ...row, cash_policy_legacy: false });
    });
  }

  /** Land aendern (nur Support, mit Grund, im Admin-Protokoll). */
  async adminSetCountry(
    organizationId: string,
    country: string,
    reason: string,
    admin: User,
    client: ClientInfo = {},
  ): Promise<CashPolicyState> {
    const code = normalizeCountry(country);
    if (!code) throw invalidCountry();
    const trimmed = reason.trim();
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockOrganization(manager, organizationId);
      if (row.country === code) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.COUNTRY_UNCHANGED,
          message: 'Die Organisation hat dieses Land schon.',
          params: { country: code },
        });
      }
      await writeCountry(manager, organizationId, code);
      await recordCashPolicyChange(manager, {
        organizationId,
        kind: 'country',
        fromValue: row.country,
        toValue: code,
        reason: trimmed,
        bySupport: true,
        user: admin,
        client,
      });
      const before = this.stateOfRow(row);
      const after = this.stateOfRow({ ...row, country: code });
      await manager.insert(AdminAuditLog, {
        adminUserId: admin.id,
        organizationId,
        action: AdminAction.SET_ORGANIZATION_COUNTRY,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          before: {
            country: before.country ?? undefined,
            cashPolicy: before.cashPolicy,
            cashPolicyLegacy: before.cashPolicyLegacy,
          },
          after: {
            country: after.country ?? undefined,
            cashPolicy: after.cashPolicy,
            cashPolicyLegacy: after.cashPolicyLegacy,
          },
        },
        reason: trimmed,
        ipAddress: (client.ipAddress || '0.0.0.0').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });
      this.logger.log(
        `Country of organization ${organizationId} changed ${row.country ?? '-'} -> ${code} by super admin ${admin.id}`,
      );
      return after;
    });
  }

  /**
   * Bestandsschutz setzen oder aufheben (nur Support, mit Grund). Der Weg
   * zurueck nach einem freiwilligen Wechsel des Vereins.
   */
  async adminSetLegacy(
    organizationId: string,
    legacy: boolean,
    reason: string,
    admin: User,
    client: ClientInfo = {},
  ): Promise<CashPolicyState> {
    const trimmed = reason.trim();
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockOrganization(manager, organizationId);
      if (row.cash_policy_legacy === legacy) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.CASH_POLICY_UNCHANGED,
          message: legacy
            ? 'Die Organisation hat schon Bestandsschutz.'
            : 'Für die Organisation gilt schon die Regel ihres Landes.',
        });
      }
      await manager.query(
        `UPDATE organizations
            SET cash_policy_legacy = $2, updated_at = now()
          WHERE id = $1`,
        [organizationId, legacy],
      );
      await recordCashPolicyChange(manager, {
        organizationId,
        kind: 'policy',
        fromValue: legacy ? 'country' : 'legacy',
        toValue: legacy ? 'legacy' : 'country',
        reason: trimmed,
        bySupport: true,
        user: admin,
        client,
      });
      const before = this.stateOfRow(row);
      const after = this.stateOfRow({ ...row, cash_policy_legacy: legacy });
      await manager.insert(AdminAuditLog, {
        adminUserId: admin.id,
        organizationId,
        action: AdminAction.SET_CASH_POLICY,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          before: {
            country: before.country ?? undefined,
            cashPolicy: before.cashPolicy,
            cashPolicyLegacy: before.cashPolicyLegacy,
          },
          after: {
            country: after.country ?? undefined,
            cashPolicy: after.cashPolicy,
            cashPolicyLegacy: after.cashPolicyLegacy,
          },
        },
        reason: trimmed,
        ipAddress: (client.ipAddress || '0.0.0.0').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });
      this.logger.log(
        `Cash policy legacy of organization ${organizationId} set to ${legacy} by super admin ${admin.id}`,
      );
      return after;
    });
  }

  /** Fuer Admin-Seiten: Zustand ohne Mitgliedschaft. */
  async stateOf(organizationId: string): Promise<CashPolicyState> {
    const organization = await this.dataSource
      .getRepository(Organization)
      .findOne({
        where: { id: organizationId },
        select: { id: true, country: true, cashPolicyLegacy: true },
      });
    return cashPolicyView(organization);
  }

  /**
   * Herstellerbescheinigung (nur Admins der Organisation), solange Bargeld
   * durch die Regel „Deutschland ohne Bargeld“ gesperrt ist.
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
    if (resolveCashPolicy(organization) !== 'blocked_de_no_tse') {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.CERTIFICATE_REQUIRES_CASH_POLICY,
        message:
          'Die Bescheinigung gibt es nur mit der Regel „Deutschland ohne Bargeld“.',
      });
    }

    const history = await this.history(organization.id);
    // Seit der letzten Aenderung von Land oder Regel (die hat den
    // heutigen Zustand hergestellt), sonst seit dem Anlegen.
    const since = history.length
      ? new Date(history[0].createdAt)
      : new Date(organization.createdAt);
    const content = buildCashPolicyCertificateContent({
      organization: {
        id: organization.id,
        name: organization.name,
        address: certificateAddress(organization),
      },
      country: organization.country ?? 'DE',
      since,
      issuedAt: new Date(),
      version:
        process.env.APP_VERSION || process.env.npm_package_version || 'dev',
      operator: operatorFromEnv((key) => this.configService.get<string>(key)),
      timeZone: organization.settings?.timezone || 'Europe/Berlin',
      history: [...history].reverse().map((h) => ({
        at: new Date(h.createdAt),
        kind: h.kind,
        fromValue: h.fromValue,
        toValue: h.toValue,
        reason: h.reason,
        bySupport: h.bySupport,
      })),
    });
    const pdf = await renderCertificatePdf(content);
    const day = new Date().toISOString().slice(0, 10);
    return {
      pdf,
      filename: `openeos-bescheinigung-ohne-bargeld-${organization.slug || organization.id}-${day}.pdf`,
    };
  }
}

/**
 * Anschrift fuer die Bescheinigung: `settings.address` (mit Strasse), sonst
 * die Kontaktadresse aus den Einstellungen, sonst die Rechnungsadresse.
 */
export function certificateAddress(organization: Organization): {
  street?: string;
  zip?: string;
  city?: string;
  country?: string;
} | null {
  const address = organization.settings?.address;
  if (address?.street?.trim()) return address;
  const contact = organization.settings?.contact as
    | { address?: string; zipCode?: string; city?: string }
    | undefined;
  if (contact?.address?.trim() || contact?.city?.trim()) {
    return {
      street: contact.address,
      zip: contact.zipCode,
      city: contact.city,
      country: organization.country ?? undefined,
    };
  }
  return organization.billingAddress ?? null;
}
