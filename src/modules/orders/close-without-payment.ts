import { ConflictException } from '@nestjs/common';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { itemsStillInProduction } from '../../common/utils/operating-mode.util';

/**
 * „Ohne Zahlung abschließen“ gab es kurz als Zwischenloesung (2026-11-01,
 * Regel „Deutschland ohne Bargeld“). Seit den Betriebsarten entsteht es
 * nicht mehr; Bestellungen mit `closed_without_payment_at` bleiben aber
 * erledigt: Jeder Zahlungsversuch darauf endet mit 409.
 */

/** 409 fuer jeden Zahlungsversuch auf eine ohne Zahlung abgeschlossene Bestellung. */
export function closedWithoutPaymentError(
  orderIds: string[],
): ConflictException {
  return new ConflictException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.ORDER_CLOSED_WITHOUT_PAYMENT,
    message:
      'Diese Bestellung wurde schon ohne Zahlung abgeschlossen (außerhalb von OpenEOS bezahlt). Lade die offenen Bestellungen neu.',
    params: { orderIds },
  });
}

type ItemLike = Parameters<typeof itemsStillInProduction>[0][number];

/**
 * Darf eine ohne Zahlung abgeschlossene Bestellung (Altbestand) jetzt
 * fertig werden? Keine Station arbeitet mehr an ihr.
 */
export function workflowDoneForClose(items: ItemLike[]): boolean {
  return itemsStillInProduction(items).length === 0;
}
