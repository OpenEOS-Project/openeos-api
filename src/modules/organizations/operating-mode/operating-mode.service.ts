import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
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
  LEGACY_FULL,
  OPERATING_MODES,
  getOperatingMode,
  isCertificateAvailable,
  modeUnavailableReason,
  operatingModeView,
  tseRequiredError,
  type ModeUnavailableReason,
  type OperatingMode,
  type OperatingModeOrg,
  type OperatingModeView,
  type TseModeContext,
  OPERATING_MODE_SELECT,
} from '../../../common/utils/operating-mode.util';
import {
  TseAutoActivationService,
  type TseSetupPlan,
} from '../../tse/tse-auto-activation.service';
import { hasActiveTse } from '../../../common/utils/tse.util';
import { DeploymentService } from '../../../common/services/deployment.service';
import { GatewayService } from '../../gateway/gateway.service';
import { OrganizationsService } from '../organizations.service';
import { actorName, type ClientInfo } from '../country/country.writes';
import { certificateAddress } from '../country/country.service';
import {
  buildCertificateContent,
  operatorFromEnv,
  renderCertificatePdf,
  type CertificateHistoryEntry,
} from './operating-mode-certificate';

export type OperatingModeHistoryEntry = Pick<
  OrganizationOperatingModeChange,
  | 'id'
  | 'createdAt'
  | 'fromMode'
  | 'toMode'
  | 'reason'
  | 'bySupport'
  | 'changedByName'
>;

export interface OperatingModeOption {
  mode: OperatingMode;
  available: boolean;
  unavailableReason: ModeUnavailableReason | null;
}

export interface OperatingModeState extends OperatingModeView {
  options: OperatingModeOption[];
  certificateAvailable: boolean;
  /**
   * Deutschland ohne aktive TSE, bezahlte Veranstaltung steht an: wann die
   * Cloud-TSE automatisch eingerichtet wird (fuer „Alle Funktionen“). Sonst
   * `null`.
   */
  tseSetup: TseSetupPlan | null;
}

interface LockedRow {
  country: string | null;
  operating_mode: string;
  operating_mode_legacy: boolean;
  operating_mode_since: Date | null;
  // Fuer hasActiveTse: `full` in Deutschland nur mit aktiver Cloud-TSE.
  tse_active?: boolean | null;
  settings?: object | null;
}

function rowToOrg(id: string, row: LockedRow): OperatingModeOrg {
  return {
    id,
    country: row.country,
    operatingMode: row.operating_mode,
    operatingModeLegacy: row.operating_mode_legacy,
    operatingModeSince: row.operating_mode_since,
    tseActive: row.tse_active ?? false,
    settings: row.settings ?? null,
  };
}

/**
 * Betriebsart einer Organisation (operating-mode.util.ts): lesen, wechseln
 * (Admins des Vereins und Support), Verlauf und Herstellerbescheinigung.
 *
 * Der Verein darf selbst wechseln, weil Bargeld in Deutschland ohne TSE in
 * keiner waehlbaren Betriebsart moeglich ist: `full` ist dort nur mit
 * aktiver TSE waehlbar — auch fuer den Support.
 */
@Injectable()
export class OperatingModeService {
  private readonly logger = new Logger(OperatingModeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly organizationsService: OrganizationsService,
    private readonly configService: ConfigService,
    private readonly deployment: DeploymentService,
    private readonly gatewayService: GatewayService,
    /* Optional, damit Tests ohne TSE-Modul auskommen; in der Anwendung
       immer vorhanden (OrganizationsModule importiert TseModule). */
    @Optional()
    private readonly tseAuto?: TseAutoActivationService,
  ) {}

  /**
   * Plan der automatischen TSE (Deutschland, keine aktive TSE, bezahlte
   * Veranstaltung) — davon haengt ab, ob „Alle Funktionen“ waehlbar ist.
   */
  private async tsePlan(
    org: OperatingModeOrg | null | undefined,
  ): Promise<TseSetupPlan | null> {
    if (!this.tseAuto || !org?.id) return null;
    if ((org.country ?? '').toUpperCase() !== 'DE' || hasActiveTse(org)) {
      return null;
    }
    return this.tseAuto.planFor({
      id: org.id,
      settings: (org.settings ?? null) as Organization['settings'],
    });
  }

  private tseContext(plan: TseSetupPlan | null): TseModeContext {
    return { available: this.tseAuto?.available ?? false, follows: !!plan };
  }

  /** Zustand samt waehlbaren Betriebsarten. */
  stateFor(
    org: OperatingModeOrg | null | undefined,
    plan: TseSetupPlan | null = null,
  ): OperatingModeState {
    const tse = this.tseContext(plan);
    return {
      ...operatingModeView(org),
      options: OPERATING_MODES.map((mode) => {
        const reason = modeUnavailableReason(org, mode, tse);
        return { mode, available: reason === null, unavailableReason: reason };
      }),
      certificateAvailable:
        !this.deployment.isSelfHosted && isCertificateAvailable(org),
      tseSetup: plan,
    };
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
  ): Promise<OperatingModeState & { history: OperatingModeHistoryEntry[] }> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    return {
      ...this.stateFor(organization, await this.tsePlan(organization)),
      // Wer im Support umgeschaltet hat, bleibt intern (Admin-Verlauf).
      history: (await this.history(organization.id)).map((h) => ({
        ...h,
        changedByName: h.bySupport ? 'OpenEOS-Support' : h.changedByName,
      })),
    };
  }

  /** Wechsel durch die Admins des Vereins (ohne Grund). */
  async setByMember(
    organizationId: string,
    mode: OperatingMode,
    user: User,
    client: ClientInfo = {},
  ): Promise<OperatingModeState> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );
    return this.switchMode(organization.id, mode, user, client, null);
  }

  /** Wechsel durch den Support (Super-Admin, Grund Pflicht). */
  adminSetMode(
    organizationId: string,
    mode: OperatingMode,
    reason: string,
    admin: User,
    client: ClientInfo = {},
  ): Promise<OperatingModeState> {
    return this.switchMode(organizationId, mode, admin, client, reason.trim());
  }

  /**
   * Wechsel samt Verlauf und Admin-Protokoll in einer Transaktion bei
   * gesperrter Organisationszeile.
   *
   * - Ohne Land: 400 COUNTRY_REQUIRED (die Regeln haengen am Land).
   * - `full` in Deutschland ohne aktive TSE: 403 TSE_REQUIRED_FOR_CASH.
   * - Gleiche Betriebsart ohne Bestand: 400 OPERATING_MODE_UNCHANGED. Mit
   *   Bestand ist `full` eine Bestaetigung und hebt den Bestand auf.
   * - Jeder Wechsel hebt den Bestand auf.
   */
  private async switchMode(
    organizationId: string,
    mode: OperatingMode,
    actor: User,
    client: ClientInfo,
    supportReason: string | null,
  ): Promise<OperatingModeState> {
    const bySupport = supportReason !== null;
    /* Ob „Alle Funktionen“ in Deutschland ohne TSE geht, haengt an einer
       bezahlten Veranstaltung — vor der Sperre nachgesehen (Lesen genuegt:
       die TSE folgt ohnehin nur mit einer bezahlten Veranstaltung). */
    const planBefore =
      mode === 'full' && this.tseAuto
        ? await this.tsePlan(
            await this.dataSource.getRepository(Organization).findOne({
              where: { id: organizationId },
              select: OPERATING_MODE_SELECT,
            }),
          )
        : null;
    const state = await this.dataSource.transaction(async (manager) => {
      const row = await this.lock(manager, organizationId);
      const before = rowToOrg(organizationId, row);
      const unavailable = modeUnavailableReason(
        before,
        mode,
        this.tseContext(planBefore),
      );
      if (unavailable === 'country_required') {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.COUNTRY_REQUIRED,
          message:
            'Lege zuerst das Land deiner Organisation fest – davon hängt ab, welche Betriebsarten möglich sind.',
        });
      }
      if (unavailable === 'tse_required') {
        throw tseRequiredError(ErrorReasons.OPERATING_MODE_FULL_REQUIRES_TSE);
      }
      if (unavailable === 'paid_event_required') {
        throw new ForbiddenException({
          code: ErrorCodes.TSE_REQUIRED_FOR_CASH,
          reason: ErrorReasons.OPERATING_MODE_FULL_REQUIRES_TSE,
          message:
            '„Alle Funktionen“ mit Bargeld geht in Deutschland nur mit Cloud-TSE. OpenEOS richtet sie automatisch ein, sobald du eine Veranstaltung freigeschaltet hast – schalte zuerst eine Veranstaltung frei.',
        });
      }
      const from = getOperatingMode(before);
      const legacy = before.operatingModeLegacy === true;
      if (from === mode && !legacy) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.OPERATING_MODE_UNCHANGED,
          message: 'Die Organisation ist bereits in dieser Betriebsart.',
          params: { mode },
        });
      }

      const changedAt = new Date();
      await manager.query(
        `UPDATE organizations
            SET operating_mode = $2,
                operating_mode_legacy = false,
                operating_mode_since = $3,
                updated_at = now()
          WHERE id = $1`,
        [organizationId, mode, changedAt],
      );
      const fromValue = from === 'full' && legacy ? LEGACY_FULL : from;
      await manager.insert(OrganizationOperatingModeChange, {
        organizationId,
        fromMode: fromValue,
        toMode: mode,
        reason: supportReason,
        bySupport,
        changedByUserId: actor.id,
        changedByName: actorName(actor),
        ipAddress: client.ipAddress?.slice(0, 45) ?? null,
        userAgent: client.userAgent?.slice(0, 500) ?? null,
        createdAt: changedAt,
      });
      await manager.insert(AdminAuditLog, {
        adminUserId: actor.id,
        organizationId,
        action: AdminAction.SET_OPERATING_MODE,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          before: { operatingMode: fromValue },
          after: { operatingMode: mode },
          bySupport,
        },
        reason: supportReason,
        ipAddress: (client.ipAddress || '0.0.0.0').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });

      this.logger.log(
        `Operating mode of organization ${organizationId} switched ${fromValue} -> ${mode} by ${bySupport ? 'super admin' : 'user'} ${actor.id}`,
      );
      return this.stateFor(
        {
          ...before,
          operatingMode: mode,
          operatingModeLegacy: false,
          operatingModeSince: changedAt,
        },
        planBefore,
      );
    });
    // Kassen laden Organisation und Betriebsart sofort neu.
    this.gatewayService.notifyOrganizationSettingsUpdated(organizationId);
    /* „Alle Funktionen“ in Deutschland mit bezahlter Veranstaltung: die
       Cloud-TSE folgt automatisch (Integration an, Anlage am ersten
       Veranstaltungstag bzw. sofort). Ein Fehler hier macht den Wechsel
       nicht rueckgaengig. */
    if (mode === 'full' && planBefore && this.tseAuto) {
      try {
        const result = await this.tseAuto.onModeSwitchedToFull(
          organizationId,
          actor.id,
        );
        return { ...state, tseSetup: result.plan ?? state.tseSetup };
      } catch (error) {
        this.logger.error(
          `Cloud-TSE after switch to full not enabled for ${organizationId}: ${(error as Error).message}`,
        );
      }
    }
    return state;
  }

  private async lock(
    manager: EntityManager,
    organizationId: string,
  ): Promise<LockedRow> {
    const [row] = await manager.query<LockedRow[]>(
      `SELECT country, operating_mode, operating_mode_legacy, operating_mode_since,
              tse_active, settings
         FROM organizations
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

  /** Fuer Admin-Seiten: Zustand ohne Mitgliedschaft. */
  async stateOf(organizationId: string): Promise<OperatingModeState> {
    const organization = await this.dataSource
      .getRepository(Organization)
      .findOne({
        where: { id: organizationId },
        select: OPERATING_MODE_SELECT,
      });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return this.stateFor(organization, await this.tsePlan(organization));
  }

  /**
   * Herstellerbescheinigung als PDF (nur Admins der Organisation, nur im
   * gehosteten Dienst): Deutschland, Betriebsart `orders_only` oder
   * `cashless`.
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
    const mode = getOperatingMode(organization);
    if (
      this.deployment.isSelfHosted ||
      mode === 'full' ||
      !isCertificateAvailable(organization)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.CERTIFICATE_NOT_AVAILABLE,
        message:
          'Die Herstellerbescheinigung gibt es für Organisationen in Deutschland in den Betriebsarten „Nur Bons“ und „Bargeldlos“.',
      });
    }

    const history = await this.history(organization.id);
    const content = buildCertificateContent({
      organization: {
        id: organization.id,
        name: organization.name,
        address: certificateAddress(organization),
      },
      mode,
      country: organization.country ?? 'DE',
      tseActive: hasActiveTse(organization),
      since: organization.operatingModeSince
        ? new Date(organization.operatingModeSince)
        : new Date(organization.createdAt),
      issuedAt: new Date(),
      version:
        process.env.APP_VERSION || process.env.npm_package_version || 'dev',
      operator: operatorFromEnv((key) => this.configService.get<string>(key)),
      timeZone: organization.settings?.timezone || 'Europe/Berlin',
      history: [...history].reverse().map(
        (h): CertificateHistoryEntry => ({
          at: new Date(h.createdAt),
          fromMode: h.fromMode,
          toMode: h.toMode,
          reason: h.reason,
          bySupport: h.bySupport,
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
}
