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

/** Entfernt Schluessel mit `null` (z. B. `tableSelectView: null` = Vorgabe der Kasse). */
export function dropNullSettings(settings: DeviceSettings): DeviceSettings {
  const out: DeviceSettings = { ...settings };
  if (out.tableSelectView === null) delete out.tableSelectView;
  if (out.refundPermission === null) delete out.refundPermission;
  return out;
}
