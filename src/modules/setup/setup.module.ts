import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  User,
  Organization,
  UserOrganization,
  CreditPackage,
} from '../../database/entities';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Organization, UserOrganization, CreditPackage]),
  ],
  controllers: [SetupController],
  providers: [SetupService],
  exports: [SetupService],
})
export class SetupModule {}
