import { randomInt } from 'crypto';

/**
 * Kopplungscode eines wartenden Geraets.
 *
 * Acht Ziffern: bleibt auf Telefon und Fernbedienung bequem eintippbar
 * (Ziffernblock). Ein Code gilt nur `PAIRING_CODE_TTL_MS`; danach meldet
 * der naechste Statusabruf 401 (PAIRING_CODE_EXPIRED), und das Geraet
 * meldet sich mit einem neuen Code neu an.
 */
export const PAIRING_CODE_LENGTH = 8;

/** Codes aus der Zeit vor der Umstellung (sechs Ziffern) gelten weiter. */
export const LEGACY_PAIRING_CODE_LENGTH = 6;

/** Gueltigkeit eines Kopplungscodes. */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Wartende Geraete, deren Code so lange abgelaufen ist, werden entfernt.
 * Ein Geraet, das noch laeuft, fragt alle paar Sekunden nach seinem Status
 * und meldet sich nach Ablauf sofort neu an; uebrig bleiben nur verlassene.
 */
export const STALE_PENDING_DEVICE_MS = 60 * 60 * 1000;

/** Hoechstens so viele wartende Geraete je Organisation (Anmeldung per Kurzname). */
export const MAX_PENDING_DEVICES_PER_ORGANIZATION = 20;

/**
 * Hoechstens so viele wartende Geraete je IP-Adresse. Grosszuegig, weil
 * beim Aufbau eines Fests viele Geraete hinter demselben WLAN haengen.
 */
export const MAX_PENDING_DEVICES_PER_IP = 30;

/** Versuche je Code (Suche und Verknuepfen) innerhalb der Gueltigkeit. */
export const PAIRING_CODE_ATTEMPT_LIMIT = {
  limit: 10,
  windowMs: PAIRING_CODE_TTL_MS,
};

/** Neuer Code aus dem Zufallsgenerator von crypto. */
export function newPairingCode(): string {
  return randomInt(0, 10 ** PAIRING_CODE_LENGTH)
    .toString()
    .padStart(PAIRING_CODE_LENGTH, '0');
}

/**
 * Eingegebenen Code bereinigen (Leerzeichen, Bindestriche). Gibt `null`
 * zurueck, wenn danach keine gueltige Laenge herauskommt.
 */
export function normalizePairingCode(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(code)) return null;
  if (
    code.length !== PAIRING_CODE_LENGTH &&
    code.length !== LEGACY_PAIRING_CODE_LENGTH
  ) {
    return null;
  }
  return code;
}

/** Ist der Code eines wartenden Geraets noch gueltig? */
export function pairingCodeValid(
  device: {
    verificationCode: string | null;
    verificationCodeExpiresAt: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    !!device.verificationCode &&
    !!device.verificationCodeExpiresAt &&
    device.verificationCodeExpiresAt.getTime() > now.getTime()
  );
}
