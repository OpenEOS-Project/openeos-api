import { BadRequestException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  REFUND_PERMISSIONS,
  TABLE_SELECT_VIEWS,
  type DeviceSettings,
} from '../../database/entities/device.entity';

/**
 * Prueft die Felder der Geraeteeinstellungen, die feste Werte haben. Das
 * Objekt selbst bleibt offen (jsonb, `[key: string]: unknown`); unbekannte
 * Schluessel werden nicht abgelehnt. `null` loescht einen Wert.
 */
export function assertDeviceSettings(
  settings: DeviceSettings | undefined | null,
): void {
  if (!settings) return;
  assertWaiterSettings(settings);
  const view = settings.tableSelectView as unknown;
  if (
    view !== undefined &&
    view !== null &&
    !(TABLE_SELECT_VIEWS as readonly unknown[]).includes(view)
  ) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.DEVICE_SETTINGS_INVALID,
      message:
        'Ungültige Tischwahl: erlaubt sind Nummer eingeben, Liste oder Karte',
      params: { field: 'tableSelectView', allowed: [...TABLE_SELECT_VIEWS] },
    });
  }
  const refund = settings.refundPermission as unknown;
  if (
    refund !== undefined &&
    refund !== null &&
    !(REFUND_PERMISSIONS as readonly unknown[]).includes(refund)
  ) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.DEVICE_SETTINGS_INVALID,
      message:
        'Ungültige Einstellung für Stornieren & Erstatten: erlaubt sind erlaubt, nur mit PIN oder aus',
      params: { field: 'refundPermission', allowed: [...REFUND_PERMISSIONS] },
    });
  }
}

const WAITER_MODES = ['off', 'shared', 'personal'] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bedienungs-Einstellungen des Geraets (Modus, feste Bedienung, Sperre). */
function assertWaiterSettings(settings: DeviceSettings): void {
  const invalid = (field: string, message: string, allowed?: unknown[]) =>
    new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.DEVICE_SETTINGS_INVALID,
      message,
      params: { field, ...(allowed ? { allowed } : {}) },
    });
  const mode = settings.waiterMode as unknown;
  if (
    mode !== undefined &&
    mode !== null &&
    !(WAITER_MODES as readonly unknown[]).includes(mode)
  ) {
    throw invalid(
      'waiterMode',
      'Ungültiger Bedienungsmodus: erlaubt sind aus, gemeinsame Kasse oder feste Bedienung',
      [...WAITER_MODES],
    );
  }
  const waiterId = settings.waiterId as unknown;
  if (
    waiterId !== undefined &&
    waiterId !== null &&
    (typeof waiterId !== 'string' || !UUID_RE.test(waiterId))
  ) {
    throw invalid('waiterId', 'Ungültige Bedienung');
  }
  if (mode === 'personal' && !waiterId) {
    throw invalid(
      'waiterId',
      'Für eine feste Bedienung wähle bitte eine Bedienung aus',
    );
  }
  const autoLock = settings.autoLockSeconds as unknown;
  if (
    autoLock !== undefined &&
    autoLock !== null &&
    (typeof autoLock !== 'number' ||
      !Number.isInteger(autoLock) ||
      autoLock < 0 ||
      autoLock > 86_400)
  ) {
    throw invalid(
      'autoLockSeconds',
      'Ungültige Zeit für die automatische Sperre (0 bis 86400 Sekunden)',
    );
  }
  for (const field of ['lockAfterPayment', 'waiterTiles'] as const) {
    const value = settings[field] as unknown;
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      throw invalid(field, 'Ungültiger Wert');
    }
  }
}

/** Entfernt Schluessel mit `null` (z. B. `tableSelectView: null` = Vorgabe der Kasse). */
export function dropNullSettings(settings: DeviceSettings): DeviceSettings {
  const out: DeviceSettings = { ...settings };
  if (out.tableSelectView === null) delete out.tableSelectView;
  if (out.refundPermission === null) delete out.refundPermission;
  if (out.waiterId === null) delete out.waiterId;
  if (out.autoLockSeconds === null) delete out.autoLockSeconds;
  // Freigabe der PIN-Sperre durch einen Admin: `waiterPinLockedAt: null`.
  if (out.waiterPinLockedAt === null) delete out.waiterPinLockedAt;
  return out;
}
