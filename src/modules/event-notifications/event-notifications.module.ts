import { Module } from '@nestjs/common';
import { EventNotificationsService } from './event-notifications.service';

/**
 * Erinnerungen zu Veranstaltungen an die Admins (Checkliste eine Woche
 * vorher, Vortag, Rueckblick, „noch nicht freigeschaltet“). Braucht nur
 * globale Dienste: Datenbank, Mail, Phasen, Betriebsart, Cron-Sperre.
 */
@Module({
  providers: [EventNotificationsService],
  exports: [EventNotificationsService],
})
export class EventNotificationsModule {}
