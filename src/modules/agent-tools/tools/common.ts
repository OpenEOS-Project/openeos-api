import type { Event } from '../../../database/entities';
import type { EventsService } from '../../events/events.service';
import type { AgentToolContext } from '../agent-tool.types';

/**
 * Jede Veranstaltung aus der Eingabe muss zur Organisation des Tokens
 * gehoeren — der REST-Guard liest das aus dem Pfad, hier liest es dieser
 * Aufruf (404, wenn die Veranstaltung nicht zur Organisation gehoert).
 */
export function assertEvent(
  events: EventsService,
  ctx: AgentToolContext,
  eventId: string,
): Promise<Event> {
  return events.findOne(ctx.organizationId, eventId, ctx.user);
}
