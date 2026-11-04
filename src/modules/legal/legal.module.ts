import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LegalAcceptance, Organization } from '../../database/entities';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { OrganizationsModule } from '../organizations/organizations.module';
import { BookingConfirmationService } from './booking-confirmation.service';
import { LegalElsterController } from './legal-elster.controller';
import { LegalElsterService } from './legal-elster.service';
import { LegalController } from './legal.controller';
import { LegalService } from './legal.service';

/**
 * Rechtstexte von LUXCODE: Fassungen, Annahme (Registrierung, erneute
 * Annahme, Buchung), Buchungsbestaetigung und die Angaben fuer die
 * ELSTER-Mitteilung.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LegalAcceptance, Organization, TseUnit]),
    OrganizationsModule,
  ],
  controllers: [LegalController, LegalElsterController],
  providers: [LegalService, LegalElsterService, BookingConfirmationService],
  exports: [LegalService, BookingConfirmationService],
})
export class LegalModule {}
