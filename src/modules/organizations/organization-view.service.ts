import { Injectable, Optional } from '@nestjs/common';

import {
  operatingModeView,
  type OperatingModeOrg,
  type OperatingModeView,
} from '../../common/utils/operating-mode.util';
import type { Organization } from '../../database/entities/organization.entity';
import { TseStatusService, type TseSummary } from '../tse/tse-status.service';

/** Was die Ansicht von einer Organisation braucht. */
export type OrganizationLike = OperatingModeOrg &
  Pick<Organization, 'id' | 'settings'>;

/**
 * Organisation, wie sie jede Antwort an Oberflaeche und Kasse traegt:
 * gespeicherte Felder plus die abgeleiteten — Land und Betriebsart
 * (`operatingMode`, `operatingModeLegacy`, `operatingModeSince`), `tseActive`,
 * `cashAllowed`, `pricesVisible` (operating-mode.util.ts) und die Cloud-TSE
 * (`tse: { available, integrationEnabled, active, state, serialNumber,
 * clientId }`, tse-swissbit-plan.md §8).
 */
export type OrganizationView<T extends OrganizationLike = Organization> = T &
  OperatingModeView & { tse: TseSummary | null };

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
    return organizations.map((organization) =>
      organizationView(organization, summaries.get(organization.id) ?? null),
    );
  }

  /**
   * Mitgliedschaften eines Benutzers (`user.userOrganizations[i].organization`)
   * in derselben Form wie `GET /organizations/:id`. Gibt eine Kopie zurueck;
   * das geladene Entity bleibt unveraendert (es koennte noch gespeichert
   * werden).
   */
  async forMemberships<
    U extends {
      userOrganizations?: Array<{ organization?: Organization | null }> | null;
    },
  >(user: U): Promise<U> {
    const memberships = user.userOrganizations;
    if (!memberships?.length) return user;
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
): OrganizationView<T> {
  return { ...organization, ...derivedFields(organization, tse) };
}
