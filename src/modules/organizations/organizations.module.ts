import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizationsController, InvitationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import {
  Organization,
  User,
  UserOrganization,
  Invitation,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Organization, User, UserOrganization, Invitation]),
    GatewayModule,
  ],
  controllers: [OrganizationsController, InvitationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
