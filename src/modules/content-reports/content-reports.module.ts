import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContentReport } from '../../database/entities/content-report.entity';
import {
  ContentReportsAdminController,
  ContentReportsController,
} from './content-reports.controller';
import { ContentReportsService } from './content-reports.service';

/** „Inhalt melden“ (Art. 16/17 DSA): Formular, Prüfung, Begründung. */
@Module({
  imports: [TypeOrmModule.forFeature([ContentReport])],
  controllers: [ContentReportsController, ContentReportsAdminController],
  providers: [ContentReportsService],
})
export class ContentReportsModule {}
