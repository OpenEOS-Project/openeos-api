import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShiftsController } from './shifts.controller';
import { ShiftsPublicController } from './shifts-public.controller';
import { ShiftsService } from './shifts.service';
import { ShiftReminderService } from './shift-reminder.service';
import { ShiftPdfService } from './shift-pdf.service';
import { ShiftPlan, ShiftJob, Shift, ShiftRegistration } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([ShiftPlan, ShiftJob, Shift, ShiftRegistration])],
  controllers: [ShiftsController, ShiftsPublicController],
  providers: [ShiftsService, ShiftReminderService, ShiftPdfService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
