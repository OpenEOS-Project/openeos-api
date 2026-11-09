import { BadRequestException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { OrganizationWaiterSettings } from '../../database/entities/organization.entity';

function invalid(field: string): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.WAITER_SETTINGS_INVALID,
    message: 'Ungültige Einstellung für Bedienungen',
    params: { field },
  });
}

/**
 * Prueft und bereinigt `settings.waiters` beim Speichern der Organisation.
 * Unbekannte Schluessel fallen weg. Die Kellnerbrieftasche bleibt aus,
 * bis der Steuerberater geantwortet hat (SB1).
 */
export function normalizeWaiterSettings(
  input: unknown,
): OrganizationWaiterSettings | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input))
    throw invalid('waiters');
  const raw = input as Record<string, unknown>;
  const out: OrganizationWaiterSettings = {};
  if (raw.pinLength !== undefined) {
    if (raw.pinLength !== 4 && raw.pinLength !== 6) throw invalid('pinLength');
    out.pinLength = raw.pinLength;
  }
  if (raw.foreignTables !== undefined) {
    if (raw.foreignTables !== 'allow' && raw.foreignTables !== 'warn') {
      throw invalid('foreignTables');
    }
    out.foreignTables = raw.foreignTables;
  }
  if (raw.receiptName !== undefined) {
    if (raw.receiptName !== 'short' && raw.receiptName !== 'full') {
      throw invalid('receiptName');
    }
    out.receiptName = raw.receiptName;
  }
  if (raw.selfSettlement !== undefined) {
    if (typeof raw.selfSettlement !== 'boolean')
      throw invalid('selfSettlement');
    out.selfSettlement = raw.selfSettlement;
  }
  if (raw.wallet !== undefined && typeof raw.wallet !== 'boolean') {
    throw invalid('wallet');
  }
  out.wallet = false;
  return out;
}
