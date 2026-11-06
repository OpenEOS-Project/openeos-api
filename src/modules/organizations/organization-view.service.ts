import { Injectable, Optional } from '@nestjs/common';

import {
  operatingModeView,
  type OperatingModeOrg,
  type OperatingModeView,
} from '../../common/utils/operating-mode.util';
import {
  OrganizationClosureService,
  type OrganizationClosure,
} from '../../common/organization-closure/organization-closure.service';
import type { Organization } from '../../database/entities/organization.entity';
import { TseStatusService, type TseSummary } from '../tse/tse-status.service';

/** Was die Ansicht von einer Organisation braucht. */
export type OrganizationLike = OperatingModeOrg &
  Pick<Organization, 'id' | 'settings'> & { deletedAt?: Date | null };

/**
 * Organisation, wie sie jede Antwort an Oberflaeche und Kasse traegt:
 * gespeicherte Felder plus die abgeleiteten — Land und Betriebsart
 * (`operatingMode`, `operatingModeLegacy`, `operatingModeSince`), `tseActive`,
 * `cashAllowed`, `pricesVisible` (operating-mode.util.ts) und die Cloud-TSE
 * (`tse: { available, integrationEnabled, active, state, serialNumber,
 * clientId }`, tse-swissbit-plan.md §8).
 */
export type OrganizationView<T extends OrganizationLike = Organization> = T &
  OperatingModeView & {
    tse: TseSummary | null;
    /**
     * Nur bei geloeschten Organisationen: bis zur endgueltigen Loeschung
     * nur noch lesend nutzbar (AGB 10.4), sonst `null`.
     */
    closure: OrganizationClosure | null;
  };

/**
 * Eine Stelle fuer die Organisations-Antworten: `GET/PATCH /organizations…`,
 * Umschalten einer Integration, Anlegen, die Liste beim Anmelden
 * (`/auth/login`, `/auth/me`, 2FA, Anmeldelink) und
 * `GET /device-api/organization`. Ohne sie gab z. B. das Umschalten einer
 * Integration die nackte Entitaet zurueck und die Oberflaeche verlor
 * `tseActive`/`cashAllowed` bis zum Neuladen.
 *
 * Die TSE-Kurzfassung kommt fuer Listen aus einer einzigen Abfrage.
 */
@Injectable()
export class OrganizationViewService {
  constructor(
    @Optional()
    private readonly tseStatus?: TseStatusService,
    @Optional()
    private readonly closures?: OrganizationClosureService,
  ) {}

  async view<T extends OrganizationLike>(
    organization: T,
  ): Promise<OrganizationView<T>> {
    const [view] = await this.views([organization]);
    return view;
  }

  /**
   * Nur die abgeleiteten Felder — fuer Antworten, die bewusst eine
   * Teilmenge der Organisation zeigen (`GET /device-api/organization`).
   */
  async derived(
    organization: OrganizationLike,
  ): Promise<OperatingModeView & { tse: TseSummary | null }> {
    const summaries = this.tseStatus
      ? await this.tseStatus.summaries([organization])
      : new Map<string, TseSummary>();
    return derivedFields(organization, summaries.get(organization.id) ?? null);
  }

  async views<T extends OrganizationLike>(
    organizations: readonly T[],
  ): Promise<OrganizationView<T>[]> {
    const summaries = this.tseStatus
      ? await this.tseStatus.summaries(organizations)
      : new Map<string, TseSummary>();
    const deleted = organizations.filter((o) => o.deletedAt).map((o) => o.id);
    const closures =
      this.closures && deleted.length > 0
        ? await this.closures.closures(deleted)
        : new Map<string, OrganizationClosure>();
    return organizations.map((organization) =>
      organizationView(
        organization,
        summaries.get(organization.id) ?? null,
        closures.get(organization.id) ?? null,
      ),
    );
  }

  /**
   * Mitgliedschaften eines Benutzers (`user.userOrganizations[i].organization`)
   * in derselben Form wie `GET /organizations/:id`. Gibt eine Kopie zurueck;
   * das geladene Entity bleibt unveraendert (es koennte noch gespeichert
   * werden).
   *
   * Geloeschte Organisationen (die Relation laedt sie nicht) bleiben bis zur
   * endgueltigen Loeschung fuer Administratoren sichtbar, mit `closure`
   * (Nur-lesen-Zugang zum Export, AGB 10.4); fuer alle anderen Mitglieder
   * und nach der endgueltigen Loeschung entfallen sie.
   */
  async forMemberships<
    U extends {
      userOrganizations?: Array<{
        organizationId?: string;
        role?: string;
        organization?: Organization | null;
      }> | null;
    },
  >(user: U): Promise<U> {
    let memberships = user.userOrganizations;
    if (!memberships?.length) return user;
    const missing = memberships
      .filter((m) => !m.organization || m.organization.deletedAt)
      .map((m) => m.organizationId ?? m.organization?.id)
      .filter((id): id is string => !!id);
    if (missing.length > 0) {
      const deleted = this.closures
        ? await this.closures.deletedOrganizations(missing)
        : [];
      const closures = this.closures
        ? await this.closures.closures(deleted.map((o) => o.id))
        : new Map<string, OrganizationClosure>();
      const byId = new Map(deleted.map((o) => [o.id, o]));
      memberships = memberships.flatMap((m) => {
        if (m.organization && !m.organization.deletedAt) return [m];
        const id = m.organizationId ?? m.organization?.id;
        const organization = id ? byId.get(id) : undefined;
        const closure = id ? closures.get(id) : undefined;
        if (!organization || !closure || closure.purged) return [];
        if (m.role !== 'admin') return [];
        return [{ ...m, organization }];
      });
    }
    const organizations = memberships
      .map((m) => m.organization)
      .filter((o): o is Organization => !!o);
    const views = await this.views(organizations);
    const byId = new Map(views.map((v) => [v.id, v]));
    return {
      ...user,
      userOrganizations: memberships.map((m) =>
        m.organization
          ? {
              ...m,
              organization: byId.get(m.organization.id) ?? m.organization,
            }
          : m,
      ),
    };
  }
}

function derivedFields(
  organization: OrganizationLike,
  tse: TseSummary | null,
): OperatingModeView & { tse: TseSummary | null } {
  return { ...operatingModeView(organization), tse };
}

/** Rein: Organisation plus abgeleitete Felder. */
export function organizationView<T extends OrganizationLike>(
  organization: T,
  tse: TseSummary | null,
  closure: OrganizationClosure | null = null,
): OrganizationView<T> {
  return { ...organization, ...derivedFields(organization, tse), closure };
}
