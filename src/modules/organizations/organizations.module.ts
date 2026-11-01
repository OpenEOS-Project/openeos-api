import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OrganizationsController,
  InvitationsController,
} from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OperatingModeService } from './operating-mode/operating-mode.service';
import { CashPolicyService } from './cash-policy/cash-policy.service';
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
  ],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService, OperatingModeService, CashPolicyService],
  exports: [OrganizationsService, OperatingModeService, CashPolicyService],
})
export class OrganizationsModule {}
