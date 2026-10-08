import { BadRequestException } from '@nestjs/common';
import { EventStatus } from '../../database/entities/event.entity';
import { PaymentMethod } from '../../database/entities/payment.entity';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';

/**
 * Im Testmodus loest die Kasse keine echten SumUp-Kartenzahlungen aus.
 *
 * Testbestellungen werden spaeter geloescht, eine echte Kartenzahlung
 * dazu waere Geld ohne Beleg. Gesperrt ist nur, was ueber das
 * SumUp-Lesegeraet laeuft (`sumup_terminal`); Bar und die manuelle
 * Kartenbuchung (`card`, fremdes Geraet ohne Anbindung) bleiben erlaubt,
 * damit sich der Kassenablauf trotzdem durchspielen laesst.
 *
 * Aufrufen an jedem Einstieg, der eine SumUp-Zahlung starten oder buchen
 * kann: Kartenleser-Checkout (Kasse und Verwaltung), Bestellung mit
 * Zahlung, Einzel-, Teil- und Sammelzahlung.
 */
export function assertSumUpAllowedInMode(
  eventStatus: EventStatus | string | null | undefined,
  paymentMethod?: PaymentMethod | string | null,
): void {
  if (
    paymentMethod !== undefined &&
    paymentMethod !== PaymentMethod.SUMUP_TERMINAL
  ) {
    return;
  }
  if (eventStatus !== EventStatus.TEST) return;
  throw new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.SUMUP_DISABLED_IN_TEST_MODE,
    message:
      'Im Testmodus löst die Kasse keine echten SumUp-Kartenzahlungen aus. Kassiere bar oder buche die Karte manuell.',
  });
}

/**
 * Modus der Organisation: Status der laufenden Veranstaltung. Aktiv geht
 * vor Test (wie `EventsService.getActiveOrTest`); ohne laufende
 * Veranstaltung `null`.
 */
export function currentEventStatus(
  events: { status: EventStatus }[],
): EventStatus | null {
  if (events.some((e) => e.status === EventStatus.ACTIVE)) {
    return EventStatus.ACTIVE;
  }
  if (events.some((e) => e.status === EventStatus.TEST)) {
    return EventStatus.TEST;
  }
  return null;
}
