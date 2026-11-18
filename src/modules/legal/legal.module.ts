import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LegalAcceptance, Organization } from '../../database/entities';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BookingConfirmationService } from './booking-confirmation.service';
import { LegalElsterController } from './legal-elster.controller';
import { LegalElsterService } from './legal-elster.service';
import { LegalController } from './legal.controller';
import { LegalAnnouncementMailer } from './announcements/legal-announcement-mailer.service';
import { LegalAnnouncementsAdminController } from './announcements/legal-announcements.controller';
import { LegalAnnouncementsService } from './announcements/legal-announcements.service';
import { LegalService } from './legal.service';

/**
 * Rechtstexte von LUXCODE: Fassungen, Annahme (Registrierung, erneute
 * Annahme, Buchung), Ankuendigung neuer Fassungen (Mail und Hinweis),
 * Buchungsbestaetigung und die Angaben fuer die ELSTER-Mitteilung.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LegalAcceptance, Organization, TseUnit]),
    OrganizationsModule,
  ],
  controllers: [
    LegalController,
    LegalElsterController,
    LegalAnnouncementsAdminController,
  ],
  providers: [
    LegalService,
    LegalElsterService,
    BookingConfirmationService,
    LegalAnnouncementsService,
    LegalAnnouncementMailer,
  ],
  exports: [LegalService, BookingConfirmationService],
})
export class LegalModule {}
