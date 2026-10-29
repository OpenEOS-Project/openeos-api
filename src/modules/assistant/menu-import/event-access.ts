import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Event, UserOrganization } from '../../../database/entities';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';

/**
 * Veranstaltung laden und pruefen, dass sie zur Organisation gehoert und
 * die Person dort Produkte pflegen darf — dieselbe Regel wie beim Anlegen
 * eines Produkts (ProductsService).
 */
export async function loadEventForProducts(
  eventRepository: Repository<Event>,
  membershipRepository: Repository<UserOrganization>,
  organizationId: string,
  eventId: string,
  userId: string,
  requireWrite: boolean,
): Promise<Event> {
  const event = await eventRepository.findOne({ where: { id: eventId } });
  if (!event || event.organizationId !== organizationId) {
    throw new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.EVENT_NOT_FOUND,
      message: 'Event nicht gefunden',
    });
  }
  const membership = await membershipRepository.findOne({
    where: { organizationId: event.organizationId, userId },
  });
  if (!membership) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.EVENT_ACCESS_DENIED,
      message: 'Kein Zugriff auf dieses Event',
    });
  }
  if (
    requireWrite &&
    membership.role !== OrganizationRole.ADMIN &&
    !membership.permissions?.products
  ) {
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
      message: 'Keine ausreichenden Berechtigungen',
    });
  }
  return event;
}
