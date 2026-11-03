import { Module } from '@nestjs/common';
import { TseModule } from '../tse/tse.module';
import { OrganizationViewModule } from './organization-view.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OrganizationsController,
  InvitationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OperatingModeService } from './operating-mode/operating-mode.service';
import { CountryService } from './country/country.service';
import {
  Organization,
  User,
  UserOrganization,
  Invitation,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      User,
      UserOrganization,
      Invitation,
    ]),
    GatewayModule,
    DevicesModule,
    TseModule,
    OrganizationViewModule,
  ],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService, OperatingModeService, CountryService],
  exports: [OrganizationsService, OperatingModeService, CountryService],
})
export class OrganizationsModule {}
