import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  AdminAction,
  AdminAuditLog,
  SYSTEM_AUDIT_IP,
  type AuditLogDetails,
} from '../../database/entities/admin-audit-log.entity';
import { OrganizationOperatingModeChange } from '../../database/entities/organization-operating-mode-change.entity';
import type { Organization } from '../../database/entities/organization.entity';
import {
  LEGACY_FULL,
  getOperatingMode,
  type OperatingModeOrg,
} from '../../common/utils/operating-mode.util';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import { missingMasterData } from '../dsfinvk/dsfinvk-master';
import { errorMessageOf } from './swissbit/swissbit.errors';
import { TseConfig } from './tse.config';
import { localDate, startOfLocalMonth } from './tse-dates';
import {
  DEFAULT_EVENT_PHASE_SETTINGS,
  EventPhaseSettings,
  salesWindow,
} from '../../common/utils/event-phase.util';
import { TseNotifyService } from './tse-notify.service';
import { rowsOf } from './tse-sql.util';
import {
  TSE_CREATE_LEAD_MS,
  TseUnitService,
  type QualifyingEvent,
} from './tse-unit.service';

/**
 * Was der Bezahldialog zur Cloud-TSE sagt:
 * - `included`: „Alle Funktionen“ in Deutschland (ausdruecklich gewaehlt) —
 *   die TSE gehoert dazu und wird automatisch eingerichtet.
 * - `optional`: Bestand in Deutschland (Bargeld ohne TSE) — der Dialog
 *   fragt „Mit Cloud-TSE (Bargeld rechtssicher)?“.
 * - `null`: keine TSE (Bargeldlos, Nur Bons, andere Laender, Server ohne
 *   Cloud-TSE).
 */
export type TseCheckoutOffer = 'included' | 'optional' | null;

export interface TseCheckoutTerms {
  offer: TseCheckoutOffer;
  /** Zuschlag je Veranstaltung, falls die TSE dazugehoert (0 = inklusive). */
  surcharge: number;
  /** Fehlende Stammdaten fuer die TSE (`taxNumber`, `street`, `zip`, `city`). */
  missing: string[];
}

/** Wie die Veranstaltung freigeschaltet wurde. */
export type UnlockPath = 'checkout' | 'invoice' | 'waived';

/** Warum die Integration automatisch eingeschaltet wurde. */
export type TseAutoSource = 'purchase' | 'operating_mode';

/** Steht in `settings.integrations.tse.auto`. */
export interface TseAutoEnabledInfo {
  source: TseAutoSource;
  eventId: string | null;
  eventName: string | null;
  path: UnlockPath | null;
  at: string;
}

/** Wann die Automatik die TSE anlegt (Betriebsart-Karte, TSE-Seite). */
export interface TseSetupPlan {
  eventId: string;
  eventName: string;
  eventStartDate: string;
  /** Tag der Anlage (YYYY-MM-DD, Berlin); heute, wenn sie schon laeuft. */
  scheduledFor: string;
  /** Fehlende Stammdaten — ohne sie ueberspringt die Automatik die Anlage. */
  missing: string[];
}

export interface TseAutoResult {
  /** Integration durch diesen Aufruf eingeschaltet. */
  integrationEnabled: boolean;
  /** Bestand → „Alle Funktionen“ (ausdruecklich) umgestellt. */
  modeSwitched: boolean;
  /** Die Integration ist (jetzt oder schon vorher) an. */
  tseFollows: boolean;
  /** TSE sofort angestossen (Veranstaltung laeuft schon / beginnt heute). */
  creationStarted: boolean;
  plan: TseSetupPlan | null;
}

const NOTHING: TseAutoResult = {
  integrationEnabled: false,
  modeSwitched: false,
  tseFollows: false,
  creationStarted: false,
  plan: null,
};

/** Grund im Protokoll, wie ihn die Oberflaeche anzeigt. */
export const AUTO_REASON_PURCHASE = 'automatisch beim Kauf';
export const AUTO_REASON_MODE =
  'automatisch beim Wechsel auf „Alle Funktionen“';

interface LockedOrg {
  country: string | null;
  operating_mode: string;
  operating_mode_legacy: boolean;
  tse_active: boolean | null;
  settings: Organization['settings'] | null;
}

/**
 * Cloud-TSE „All inclusive“ (tse-swissbit-plan.md §3/§8.3, Entscheidung
 * 2026-11-03): Kauft eine deutsche Organisation in „Alle Funktionen“ eine
 * Veranstaltung (Zahlung, Rechnung oder erlassen), schaltet OpenEOS die
 * Integration `tse` selbst ein; die Automatik (`TseUnitService.autoCreate`)
 * legt die TSE am ersten Geschaeftstag an — sofort, wenn die Veranstaltung
 * schon laeuft. Bestandsorganisationen werden im Bezahldialog gefragt; ein
 * „Ja“ stellt sie auf „Alle Funktionen“ (ausdruecklich) um. Dasselbe gilt
 * beim Wechsel auf „Alle Funktionen“ mit bezahlter Veranstaltung.
 *
 * Fehler hier duerfen eine Zahlung nie zurueckdrehen: die Aufrufer fangen
 * sie und protokollieren nur.
 */
@Injectable()
export class TseAutoActivationService {
  private readonly logger = new Logger(TseAutoActivationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: TseConfig,
    private readonly units: TseUnitService,
    private readonly notify: TseNotifyService,
    private readonly configService: ConfigService,
  ) {}

  /** Bietet dieser Server die Cloud-TSE an? */
  get available(): boolean {
    return this.config.enabled;
  }

  /** `TSE_EVENT_SURCHARGE_EUR`, auf Cent gerundet, nie negativ. */
  get surchargePerEvent(): number {
    const raw = Number(
      this.configService.get<number>('billing.tseEventSurchargeEur', 0),
    );
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.round(raw * 100) / 100;
  }

  /** Was der Bezahldialog zur TSE zeigt (siehe `TseCheckoutOffer`). */
  checkoutTerms(
    organization: OperatingModeOrg & Pick<Organization, 'settings'>,
  ): TseCheckoutTerms {
    const offer = this.offerFor(organization);
    return {
      offer,
      surcharge: offer ? this.surchargePerEvent : 0,
      missing: offer
        ? missingMasterData({ name: '', settings: organization.settings })
        : [],
    };
  }

  /**
   * Gehoert die TSE zu dieser Freischaltung? `included` → ja, `optional` →
   * die Antwort (ohne Antwort: nein, der Bestand bleibt), sonst `null`.
   */
  inclusionFor(
    organization: OperatingModeOrg,
    withTse: boolean | null | undefined,
  ): boolean | null {
    const offer = this.offerFor(organization);
    if (offer === 'included') return true;
    if (offer === 'optional') return withTse === true;
    return null;
  }

  /** Zuschlag fuer eine Freischaltung mit/ohne TSE. */
  surchargeFor(included: boolean | null): number {
    return included === true ? this.surchargePerEvent : 0;
  }

  private offerFor(organization: OperatingModeOrg): TseCheckoutOffer {
    if (!this.config.enabled) return null;
    if ((organization.country ?? '').toUpperCase() !== 'DE') return null;
    if (getOperatingMode(organization) !== 'full') return null;
    return organization.operatingModeLegacy === true ? 'optional' : 'included';
  }

  // ------------------------------------------------------------- Kauf

  /**
   * Nach dem Freischalten (Stripe bezahlt, Rechnung ausgestellt, erlassen).
   * `withTse` ist die Antwort einer Bestandsorganisation im Bezahldialog;
   * fuer „Alle Funktionen“ ohne Bedeutung. Idempotent.
   */
  async onEventUnlocked(params: {
    organizationId: string;
    eventId: string;
    eventName: string;
    path: UnlockPath;
    withTse: boolean | null | undefined;
    actorUserId: string | null;
  }): Promise<TseAutoResult> {
    if (!this.config.enabled) return NOTHING;
    const outcome = await this.dataSource.transaction(async (manager) => {
      const org = await this.lock(manager, params.organizationId);
      if (!org || (org.country ?? '').toUpperCase() !== 'DE') return null;
      if (org.operating_mode !== 'full') return null;
      const legacy = org.operating_mode_legacy === true;
      if (legacy && params.withTse !== true) return null;

      let modeSwitched = false;
      if (legacy) {
        modeSwitched = await this.switchLegacyToFull(manager, params);
      }
      const enabled = await this.enableIntegration(
        manager,
        params.organizationId,
        {
          source: 'purchase',
          eventId: params.eventId,
          eventName: params.eventName,
          path: params.path,
          at: new Date().toISOString(),
        },
        params.actorUserId,
      );
      return { modeSwitched, enabled };
    });
    if (!outcome) return NOTHING;

    if (outcome.enabled || outcome.modeSwitched) {
      this.notify.settingsChanged(params.organizationId);
      this.logger.log(
        `Cloud-TSE integration enabled automatically for org ${params.organizationId} ` +
          `(purchase of event ${params.eventId} via ${params.path}${outcome.modeSwitched ? ', legacy → full' : ''})`,
      );
    }
    return {
      integrationEnabled: outcome.enabled,
      modeSwitched: outcome.modeSwitched,
      tseFollows: true,
      ...(await this.startIfDue(params.organizationId)),
    };
  }

  // ------------------------------------------------------- Betriebsart

  /**
   * Nach einem Wechsel auf „Alle Funktionen“ (Verein oder Support): mit
   * bezahlter Veranstaltung in Deutschland folgt die TSE automatisch.
   */
  async onModeSwitchedToFull(
    organizationId: string,
    actorUserId: string | null,
  ): Promise<TseAutoResult> {
    if (!this.config.enabled) return NOTHING;
    const first = (await this.units.qualifyingEvents(organizationId))[0];
    if (!first) return NOTHING;
    const enabled = await this.dataSource.transaction(async (manager) => {
      const org = await this.lock(manager, organizationId);
      if (!org || (org.country ?? '').toUpperCase() !== 'DE') return null;
      if (org.operating_mode !== 'full' || org.operating_mode_legacy) {
        return null;
      }
      return this.enableIntegration(
        manager,
        organizationId,
        {
          source: 'operating_mode',
          eventId: first.id,
          eventName: first.name,
          path: null,
          at: new Date().toISOString(),
        },
        actorUserId,
      );
    });
    if (enabled === null) return NOTHING;
    if (enabled) {
      this.notify.settingsChanged(organizationId);
      this.logger.log(
        `Cloud-TSE integration enabled automatically for org ${organizationId} (switch to full, event ${first.id})`,
      );
    }
    return {
      integrationEnabled: enabled,
      modeSwitched: false,
      tseFollows: true,
      ...(await this.startIfDue(organizationId)),
    };
  }

  /**
   * Darf „Alle Funktionen“ in Deutschland ohne aktive TSE gewaehlt werden?
   * Ja, wenn der Server die TSE anbietet und eine bezahlte Veranstaltung
   * ansteht — die TSE folgt dann automatisch. Liefert den Plan (oder `null`).
   */
  async planFor(
    organization: Pick<Organization, 'id' | 'settings'>,
    now = new Date(),
  ): Promise<TseSetupPlan | null> {
    if (!this.config.enabled) return null;
    const first = (await this.units.qualifyingEvents(organization.id, now))[0];
    if (!first) return null;
    return planOf(first, organization.settings, now);
  }

  // ------------------------------------------------------------ intern

  /** Schaltet die Integration ein, falls sie aus ist. `true` = geaendert. */
  private async enableIntegration(
    manager: EntityManager,
    organizationId: string,
    auto: TseAutoEnabledInfo,
    actorUserId: string | null,
  ): Promise<boolean> {
    const entry = { enabled: true, enabledAt: auto.at, auto };
    const rows = rowsOf<{ id: string }>(
      await manager.query(
        `UPDATE organizations
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{integrations}',
                  CASE WHEN jsonb_typeof(settings->'integrations') = 'object'
                       THEN settings->'integrations'
                       ELSE '{}'::jsonb
                  END || jsonb_build_object('tse', $2::jsonb),
                  true
                ),
                updated_at = now()
          WHERE id = $1
            AND COALESCE(settings -> 'integrations' -> 'tse' -> 'enabled', 'false'::jsonb) <> 'true'::jsonb
          RETURNING id`,
        [organizationId, JSON.stringify(entry)],
      ),
    );
    if (rows.length === 0) return false;
    const audit = manager.getRepository(AdminAuditLog);
    await audit.save(
      audit.create({
        adminUserId: actorUserId,
        organizationId,
        action: AdminAction.TSE_INTEGRATION_ENABLED,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          integration: 'tse',
          enabled: true,
          automatic: true,
          source: auto.source,
          eventId: auto.eventId,
          eventName: auto.eventName,
          path: auto.path,
        } as AuditLogDetails,
        reason:
          auto.source === 'purchase' ? AUTO_REASON_PURCHASE : AUTO_REASON_MODE,
        ipAddress: SYSTEM_AUDIT_IP,
        userAgent: null,
      }),
    );
    return true;
  }

  /** Bestand → „Alle Funktionen“ (ausdruecklich), mit Verlauf und Protokoll. */
  private async switchLegacyToFull(
    manager: EntityManager,
    params: {
      organizationId: string;
      eventName: string;
      actorUserId: string | null;
    },
  ): Promise<boolean> {
    const changedAt = new Date();
    const rows = rowsOf<{ id: string }>(
      await manager.query(
        `UPDATE organizations
            SET operating_mode_legacy = false, operating_mode_since = $2,
                updated_at = now()
          WHERE id = $1 AND operating_mode = 'full' AND operating_mode_legacy = true
          RETURNING id`,
        [params.organizationId, changedAt],
      ),
    );
    if (rows.length === 0) return false;
    const reason = `Cloud-TSE beim Kauf von „${params.eventName}“ gewählt`;
    await manager.insert(OrganizationOperatingModeChange, {
      organizationId: params.organizationId,
      fromMode: LEGACY_FULL,
      toMode: 'full',
      reason,
      bySupport: false,
      changedByUserId: params.actorUserId,
      changedByName: 'OpenEOS (Cloud-TSE)',
      createdAt: changedAt,
    });
    const audit = manager.getRepository(AdminAuditLog);
    await audit.save(
      audit.create({
        adminUserId: params.actorUserId,
        organizationId: params.organizationId,
        action: AdminAction.SET_OPERATING_MODE,
        resourceType: 'organization',
        resourceId: params.organizationId,
        details: {
          before: { operatingMode: LEGACY_FULL },
          after: { operatingMode: 'full' },
          bySupport: false,
          automatic: true,
        } as AuditLogDetails,
        reason,
        ipAddress: SYSTEM_AUDIT_IP,
        userAgent: null,
      }),
    );
    return true;
  }

  /**
   * Laeuft die Veranstaltung schon (bzw. beginnt sie im heutigen
   * Geschaeftstag), die TSE gleich anlegen statt auf den naechsten
   * stuendlichen Lauf zu warten. Sonst bleibt es beim Plan.
   */
  private async startIfDue(
    organizationId: string,
  ): Promise<Pick<TseAutoResult, 'creationStarted' | 'plan'>> {
    let creationStarted = false;
    try {
      creationStarted =
        (await this.units.autoCreate(new Date(), organizationId)).length > 0;
    } catch (error) {
      this.logger.error(
        `Immediate TSE creation for org ${organizationId} failed: ${errorMessageOf(error)}`,
      );
    }
    const [org] = rowsOf<{ id: string; settings: Organization['settings'] }>(
      await this.dataSource.query(
        `SELECT id, settings FROM organizations WHERE id = $1`,
        [organizationId],
      ),
    );
    const plan = org ? await this.planFor(org) : null;
    return { creationStarted, plan };
  }

  private async lock(
    manager: EntityManager,
    organizationId: string,
  ): Promise<LockedOrg | null> {
    const [row] = rowsOf<LockedOrg>(
      await manager.query(
        `SELECT country, operating_mode, operating_mode_legacy, tse_active, settings
           FROM organizations
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [organizationId],
      ),
    );
    return row ?? null;
  }
}

/** `settings.integrations.tse.auto`, falls die Integration so an ging. */
export function tseAutoEnabledInfo(
  settings: object | null | undefined,
): TseAutoEnabledInfo | null {
  if (!isIntegrationEnabled(settings, 'tse')) return null;
  const auto = (
    settings as { integrations?: { tse?: { auto?: unknown } } } | null
  )?.integrations?.tse?.auto;
  if (!auto || typeof auto !== 'object') return null;
  const a = auto as Partial<TseAutoEnabledInfo>;
  if (a.source !== 'purchase' && a.source !== 'operating_mode') return null;
  return {
    source: a.source,
    eventId: typeof a.eventId === 'string' ? a.eventId : null,
    eventName: typeof a.eventName === 'string' ? a.eventName : null,
    path:
      a.path === 'checkout' || a.path === 'invoice' || a.path === 'waived'
        ? a.path
        : null,
    at: typeof a.at === 'string' ? a.at : '',
  };
}

/**
 * Tag, an dem die Automatik die TSE fuer diese Veranstaltung anlegt
 * (`isTseCreationDue`): 12 Stunden vor Beginn des Verkaufsfensters, also
 * meist am Vortag des ersten Geschaeftstags — nie vor dem Monat des ersten
 * Geschaeftstags (Fest am 1.: am 1. um 0 Uhr) und nie vor heute.
 */
export function autoCreationDay(
  event: Pick<QualifyingEvent, 'startDate' | 'endDate'>,
  now = new Date(),
  settings: EventPhaseSettings = DEFAULT_EVENT_PHASE_SETTINGS,
): string {
  const window = salesWindow(
    { startDate: event.startDate, endDate: event.endDate ?? null },
    { timezone: 'Europe/Berlin', usesCloudTse: true },
    settings,
  );
  const today = localDate(now);
  if (!window) return today;
  const from = Math.max(
    startOfLocalMonth(window.businessDaysFrom).getTime(),
    window.realSalesFrom.getTime() - TSE_CREATE_LEAD_MS,
  );
  const day = localDate(new Date(from));
  return day < today ? today : day;
}

function planOf(
  event: QualifyingEvent,
  settings: Organization['settings'] | null,
  now: Date,
): TseSetupPlan {
  return {
    eventId: event.id,
    eventName: event.name,
    eventStartDate: event.startDate.toISOString(),
    scheduledFor: autoCreationDay(event, now),
    missing: missingMasterData({ name: '', settings }),
  };
}
