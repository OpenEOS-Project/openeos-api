import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../database/entities/organization.entity';
import { TseTransaction } from '../../database/entities/tse-transaction.entity';
import type { TseUnit } from '../../database/entities/tse-unit.entity';
import type { User } from '../../database/entities/user.entity';
import { isIntegrationEnabled } from '../integrations/integration-catalog';
import { tseAutoEnabledInfo } from './tse-auto-activation.service';
import { TseConfig } from './tse.config';
import { TseExportService } from './tse-export.service';
import { TseOutageService } from './tse-outage.service';
import { TseSigningService } from './tse-signing.service';
import { TseUnitService } from './tse-unit.service';
import type { TseReceiptView } from './tse-view';

/** Kurzfassung fuer `GET /organizations/:id` und `GET /device-api/organization`. */
export interface TseSummary {
  /** Ist auf diesem Server eine Cloud-TSE verfuegbar? */
  available: boolean;
  integrationEnabled: boolean;
  /** Integration an und TSE aktiv (= hasActiveTse). */
  active: boolean;
  state: TseUnit['state'] | null;
  serialNumber: string | null;
  clientId: string | null;
}

/**
 * Kurzfassung aus der neuesten TSE der Organisation (auch deaktiviert oder
 * gescheitert, damit die Oberflaeche den letzten Stand zeigt). `active` nur
 * mit eingeschalteter Integration — wie `hasActiveTse`.
 */
export function tseSummaryOf(
  organization: Pick<Organization, 'settings'>,
  latest: TseUnit | null,
  available: boolean,
): TseSummary {
  const integrationEnabled = isIntegrationEnabled(organization.settings, 'tse');
  return {
    available,
    integrationEnabled,
    active: integrationEnabled && latest?.state === 'active',
    state: latest?.state ?? null,
    serialNumber: latest?.serialNumber ?? null,
    clientId: latest?.clientId ?? null,
  };
}

export function unitView(unit: TseUnit) {
  const iso = (d: Date | null | undefined) =>
    d ? new Date(d).toISOString() : null;
  return {
    id: unit.id,
    provider: unit.provider,
    state: unit.state,
    serialNumber: unit.serialNumber,
    clientId: unit.clientId,
    productType: unit.productType,
    trigger: unit.trigger,
    triggerEventId: unit.triggerEventId,
    createdAt: iso(unit.createdAt),
    activatedAt: iso(unit.activatedAt),
    failedAt: iso(unit.failedAt),
    deactivatedAt: iso(unit.deactivatedAt),
    deactivationReason: unit.deactivationReason,
    certificationId: unit.certificationId,
    certificateExpiresAt: iso(unit.certificateExpiresAt),
    signatureAlgorithm: unit.signatureAlgorithm,
    logTimeFormat: unit.logTimeFormat,
    publicKey: unit.publicKey,
    lastError: unit.lastErrorCode
      ? {
          code: unit.lastErrorCode,
          message: unit.lastErrorMessage,
          at: iso(unit.lastErrorAt),
        }
      : null,
  };
}

/**
 * Antworten fuer Verwaltung, Kasse und Organisations-Endpunkte.
 * Enthaelt nie das Access Token.
 */
@Injectable()
export class TseStatusService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(TseTransaction)
    private readonly txRepository: Repository<TseTransaction>,
    private readonly config: TseConfig,
    private readonly units: TseUnitService,
    private readonly outages: TseOutageService,
    private readonly exports: TseExportService,
    private readonly signing: TseSigningService,
  ) {}

  async summary(
    organization: Pick<Organization, 'id' | 'settings'>,
  ): Promise<TseSummary> {
    const latest = await this.units.findLatest(organization.id);
    return tseSummaryOf(organization, latest, this.config.enabled);
  }

  /**
   * `summary` fuer mehrere Organisationen mit einer Abfrage (Liste beim
   * Anmelden, `GET /organizations`). Schluessel ist die Organisations-ID.
   */
  async summaries(
    organizations: ReadonlyArray<Pick<Organization, 'id' | 'settings'>>,
  ): Promise<Map<string, TseSummary>> {
    const result = new Map<string, TseSummary>();
    if (organizations.length === 0) return result;
    const latest = await this.units.findLatestFor(
      organizations.map((o) => o.id),
    );
    for (const organization of organizations) {
      result.set(
        organization.id,
        tseSummaryOf(
          organization,
          latest.get(organization.id) ?? null,
          this.config.enabled,
        ),
      );
    }
    return result;
  }

  /** `GET /device-api/status` → `tse`. `null` ohne Integration und TSE. */
  async deviceStatus(organizationId: string) {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: { id: true, settings: true },
    });
    if (!organization || !isIntegrationEnabled(organization.settings, 'tse')) {
      return null;
    }
    const unit = await this.units.findLive(organizationId);
    if (!unit) {
      return {
        state: 'inactive' as const,
        active: false,
        serialNumber: null,
        clientId: null,
        outage: null,
      };
    }
    const outage =
      unit.state === 'active' ? await this.outages.findOpen(unit.id) : null;
    return {
      state:
        unit.state === 'creating'
          ? ('creating' as const)
          : outage
            ? ('error' as const)
            : ('ok' as const),
      active: unit.state === 'active',
      serialNumber: unit.serialNumber,
      clientId: unit.clientId,
      outage: outage
        ? {
            since: outage.startedAt.toISOString(),
            reason: outage.reason,
            failedCount: outage.failedCount,
          }
        : null,
    };
  }

  /** `GET /organizations/:id/tse` (Admins). */
  async status(organizationId: string, user: User) {
    const organization = await this.units.assertAdmin(organizationId, user);
    const [eligibility, history] = await Promise.all([
      this.units.eligibility(organization),
      this.units.history(organizationId),
    ]);
    const unit =
      history.find((u) => u.state === 'creating' || u.state === 'active') ??
      history[0] ??
      null;
    const live = unit ? await this.units.liveStatus(unit) : null;
    const outage =
      unit && unit.state === 'active'
        ? await this.outages.findOpen(unit.id)
        : null;
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const counts = unit
      ? await this.units.transactionCounts(unit.id, since)
      : null;
    const lastExport = await this.exports.lastDownloaded(organizationId);
    const info = live?.value ?? null;
    const { qualifying: _qualifying, ...eligibilityView } = eligibility;
    return {
      available: this.config.enabled,
      integrationEnabled: isIntegrationEnabled(organization.settings, 'tse'),
      /* Automatisch eingeschaltet (beim Kauf einer Veranstaltung bzw. beim
         Wechsel auf „Alle Funktionen“): `{ source, eventId, eventName, path,
         at }`, sonst null. Ein Umschalten von Hand loescht die Angabe. */
      integrationEnabledAuto: tseAutoEnabledInfo(organization.settings),
      lifecycle: this.config.lifecycle,
      country: organization.country ?? null,
      eligibility: eligibilityView,
      unit: unit ? unitView(unit) : null,
      live: info
        ? {
            fetchedAt: live?.fetchedAt ?? null,
            healthState: info.healthState,
            initializationState: info.initializationState,
            storageUsed: info.storageUsed,
            storageCapacity: info.storageCapacity,
            signaturesThisMonth:
              info.productTypeUsage?.signaturesCurrentMonth ?? null,
            transactionSignaturesPerMonth: info.transactionSignaturesPerMonth,
            productTypeUsage: info.productTypeUsage,
            numStartedTransactions: info.numStartedTransactions,
            maxStartedTransactions: info.maxStartedTransactions,
            numRegisteredClients: info.numRegisteredClients,
            maxRegisteredClients: info.maxRegisteredClients,
            certificationId: info.certificationId,
            certificateExpiresAt: info.certificateExpirationDate
              ? new Date(info.certificateExpirationDate * 1000).toISOString()
              : null,
            softwareVersion: info.softwareVersion,
          }
        : null,
      liveError: live?.error ?? null,
      outage: outage
        ? {
            since: outage.startedAt.toISOString(),
            reason: outage.reason,
            failedCount: outage.failedCount,
          }
        : null,
      counts,
      exports: {
        lastDownloadedAt: lastExport?.downloadedAt?.toISOString() ?? null,
        pending: await this.exports.pendingCount(organizationId),
      },
      history: history.map(unitView),
    };
  }

  async transactions(
    organizationId: string,
    user: User,
    query: { status?: string; limit?: number; offset?: number },
  ): Promise<{ items: TseReceiptView[]; total: number }> {
    await this.units.assertAdmin(organizationId, user);
    const [rows, total] = await this.txRepository.findAndCount({
      where: {
        organizationId,
        ...(query.status
          ? { status: query.status as TseTransaction['status'] }
          : {}),
      },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
    });
    return { items: await this.signing.viewsFor(rows), total };
  }

  async outageList(organizationId: string, user: User) {
    await this.units.assertAdmin(organizationId, user);
    const rows = await this.outages.list(organizationId);
    return rows.map((o) => ({
      id: o.id,
      tseUnitId: o.tseUnitId,
      startedAt: o.startedAt.toISOString(),
      endedAt: o.endedAt ? o.endedAt.toISOString() : null,
      reason: o.reason,
      lastErrorMessage: o.lastErrorMessage,
      failedCount: o.failedCount,
    }));
  }
}
