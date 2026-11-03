import { isIntegrationEnabled } from '../../modules/integrations/integration-catalog';

/**
 * Cloud-TSE der Organisation (technische Sicherheitseinrichtung, § 146a AO).
 *
 * Einzige Stelle, an der OpenEOS fragt, ob eine Organisation eine aktive,
 * zertifizierte TSE hat. In Deutschland haengt daran, ob die Betriebsart
 * `full` (mit Bargeld) waehlbar und wirksam ist (operating-mode.util.ts).
 *
 * Aktiv heisst (tse-swissbit-plan.md §8): die Integration `tse` ist
 * eingeschaltet **und** die TSE der Organisation ist im Zustand `active`.
 * Den Zustand spiegelt das TSE-Modul in `organizations.tse_active`
 * (TseUnitService), damit jede Barzahlung ohne Zusatzabfrage pruefen kann;
 * die Spalte steht in `OPERATING_MODE_SELECT`.
 *
 * Tests koennen den Wert ueber `tseStatus.isActive` setzen und stellen ihn
 * danach mit `resetTseStatus()` zurueck.
 */
export interface TseOrg {
  id?: string;
  country?: string | null;
  settings?: object | null;
  tseActive?: boolean | null;
}

/** Die echte Pruefung (Integration an + TSE aktiv). */
export function isTseActiveForOrg(org: TseOrg): boolean {
  return org.tseActive === true && isIntegrationEnabled(org.settings, 'tse');
}

export const tseStatus: {
  isActive: (org: TseOrg) => boolean;
} = {
  isActive: isTseActiveForOrg,
};

export function resetTseStatus(): void {
  tseStatus.isActive = isTseActiveForOrg;
}

/** Hat die Organisation eine aktive Cloud-TSE? */
export function hasActiveTse(org: TseOrg | null | undefined): boolean {
  if (!org) return false;
  return tseStatus.isActive(org) === true;
}
