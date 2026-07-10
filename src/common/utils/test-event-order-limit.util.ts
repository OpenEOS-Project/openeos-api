import { ForbiddenException } from '@nestjs/common';
import { EventStatus } from '../../database/entities/event.entity';
import { ErrorCodes } from '../constants/error-codes';

/**
 * Order-creation cap for events in TEST status. Duplicated across every
 * order-creation entry point (orders.service.ts, device-api.controller.ts,
 * events-shop-checkout.controller.ts) — call this at each one rather than
 * adding a new check ad hoc, so the limit and message stay consistent.
 */
export function assertTestEventOrderLimitNotReached(
  eventStatus: EventStatus,
  currentOrderCount: number,
  maxOrders: number,
): void {
  if (eventStatus !== EventStatus.TEST) return;

  if (currentOrderCount >= maxOrders) {
    throw new ForbiddenException({
      code: ErrorCodes.TEST_LIMIT_REACHED,
      message: `Test-Limit erreicht (${maxOrders} Bestellungen). Schalten Sie die Veranstaltung frei, um weiter zu kassieren.`,
    });
  }
}
