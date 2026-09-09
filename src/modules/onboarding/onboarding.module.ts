import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Category, Device, Event, Product } from '../../database/entities';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [TypeOrmModule.forFeature([Event, Category, Product, Device]), OrganizationsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
