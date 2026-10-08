import { BadRequestException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
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
}

/** Entfernt Schluessel mit `null` (z. B. `tableSelectView: null` = Vorgabe der Kasse). */
export function dropNullSettings(settings: DeviceSettings): DeviceSettings {
  const out: DeviceSettings = { ...settings };
  if (out.tableSelectView === null) delete out.tableSelectView;
  return out;
}
