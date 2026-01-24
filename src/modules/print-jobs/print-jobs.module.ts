import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintJobsController } from './print-jobs.controller';
import { PrintJobsService } from './print-jobs.service';
import { PrintJob, Printer, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([PrintJob, Printer, UserOrganization])],
  controllers: [PrintJobsController],
  providers: [PrintJobsService],
  exports: [PrintJobsService],
})
export class PrintJobsModule {}
