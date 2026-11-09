import type { RetentionConfig } from '../retention/retention.config';

/** Fristen der Bedienungen (bedienungen-plan.md §10, Entscheidung 9). */
export interface WaiterRetentionPeriods {
  /** Veranstaltungsgebunden: Tage nach dem Ende; organisationsweit: nach der Deaktivierung. */
  dataDays: number;
  /** Organisationsweit: Monate ohne Anmeldung. */
  inactiveMonths: number;
  /** Sitzungen (Anmeldungen an Geraeten). */
  sessionDays: number;
}

export function waiterRetentionPeriods(
  config: Pick<
    RetentionConfig,
    'waiterDataDays' | 'waiterInactiveMonths' | 'waiterSessionDays'
  >,
): WaiterRetentionPeriods {
  return {
    dataDays: config.waiterDataDays,
    inactiveMonths: config.waiterInactiveMonths,
    sessionDays: config.waiterSessionDays,
  };
}

const DAY_MS = 86_400_000;

function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Ab wann der Loeschlauf `waiter_data` eine Bedienung anonymisiert
 * (frueheste der zutreffenden Fristen), null = derzeit keine Frist (z. B.
 * laufende Veranstaltung ohne Enddatum) oder schon anonymisiert.
 *
 * - veranstaltungsgebunden: Ende (bzw. Loeschung) der Veranstaltung + Tage
 * - organisationsweit: Deaktivierung + Tage, sonst letzte Nutzung
 *   (bzw. Anlage) + Monate
 */
export function waiterAnonymizeDueAt(
  waiter: {
    eventId: string | null;
    isActive: boolean;
    deactivatedAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    anonymizedAt: Date | null;
  },
  event: {
    end_date: Date | string | null;
    deleted_at: Date | string | null;
  } | null,
  periods: WaiterRetentionPeriods,
): Date | null {
  if (waiter.anonymizedAt) return null;
  const dataMs = periods.dataDays * DAY_MS;
  if (waiter.eventId) {
    const ends = [event?.end_date, event?.deleted_at]
      .filter((value): value is Date | string => !!value)
      .map((value) => new Date(value).getTime());
    if (!ends.length) return null;
    return new Date(Math.min(...ends) + dataMs);
  }
  const candidates: number[] = [
    addMonths(
      new Date(waiter.lastUsedAt ?? waiter.createdAt),
      periods.inactiveMonths,
    ).getTime(),
  ];
  if (!waiter.isActive && waiter.deactivatedAt) {
    candidates.push(new Date(waiter.deactivatedAt).getTime() + dataMs);
  }
  return new Date(Math.min(...candidates));
}
