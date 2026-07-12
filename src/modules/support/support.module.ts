import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event, Organization, SupportMessage, UserOrganization } from '../../database/entities';
import { SupportController } from './support.controller';
import { SupportAdminController } from './support-admin.controller';
import { SupportService } from './support.service';
import { TelegramSupportService } from './telegram-support.service';

@Module({
  imports: [TypeOrmModule.forFeature([SupportMessage, Organization, UserOrganization, Event])],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService, TelegramSupportService],
  exports: [SupportService, TelegramSupportService],
})
export class SupportModule {}
