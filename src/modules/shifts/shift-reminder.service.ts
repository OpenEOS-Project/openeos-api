import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull } from 'typeorm';
import {
  ShiftPlan,
  ShiftPlanStatus,
  Shift,
  ShiftRegistration,
  ShiftRegistrationStatus,
} from '../../database/entities';
import { EmailService } from '../email/email.service';

@Injectable()
export class ShiftReminderService {
  private readonly logger = new Logger(ShiftReminderService.name);

  constructor(
    @InjectRepository(ShiftPlan)
    private readonly shiftPlanRepository: Repository<ShiftPlan>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    @InjectRepository(ShiftRegistration)
    private readonly registrationRepository: Repository<ShiftRegistration>,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Runs every day at 8:00 AM to send shift reminders
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async handleShiftReminders() {
    this.logger.log('Starting shift reminder job...');

    try {
      // Get all published shift plans
      const plans = await this.shiftPlanRepository.find({
        where: { status: ShiftPlanStatus.PUBLISHED },
      });

      for (const plan of plans) {
        const reminderDays = plan.settings?.reminderDaysBefore ?? 1;
        if (reminderDays <= 0) {
          continue; // Skip if reminders are disabled
        }

        await this.sendRemindersForPlan(plan, reminderDays);
      }

      this.logger.log('Shift reminder job completed');
    } catch (error) {
      this.logger.error('Error running shift reminder job:', error);
    }
  }

  private async sendRemindersForPlan(plan: ShiftPlan, reminderDays: number) {
    // Calculate the target date (today + reminderDays)
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + reminderDays);
    const targetDateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD

    // Find all shifts for this plan on the target date
    const shifts = await this.shiftRepository
      .createQueryBuilder('shift')
      .innerJoin('shift.job', 'job')
      .where('job.planId = :planId', { planId: plan.id })
      .andWhere('shift.date = :date', { date: targetDateStr })
      .getMany();

    if (shifts.length === 0) {
      return;
    }

    // Get confirmed registrations that haven't received a reminder
    for (const shift of shifts) {
      const registrations = await this.registrationRepository.find({
        where: {
          shiftId: shift.id,
          status: ShiftRegistrationStatus.CONFIRMED,
          reminderSentAt: IsNull(),
        },
        relations: ['shift', 'shift.job'],
      });

      for (const registration of registrations) {
        await this.sendReminderEmail(registration, plan);
      }
    }
  }

  private async sendReminderEmail(registration: ShiftRegistration, plan: ShiftPlan) {
    try {
      const shift = registration.shift;
      const job = shift?.job;

      if (!shift || !job) {
        this.logger.warn(`Missing shift or job for registration ${registration.id}`);
        return;
      }

      const shiftDate = new Date(shift.date);
      const formattedDate = shiftDate.toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });

      await this.emailService.sendShiftReminderEmail({
        to: registration.email,
        helperName: registration.name,
        planName: plan.name,
        jobName: job.name,
        shiftDate: formattedDate,
        shiftTime: `${shift.startTime} - ${shift.endTime}`,
      });

      // Mark reminder as sent
      registration.reminderSentAt = new Date();
      await this.registrationRepository.save(registration);

      this.logger.log(`Sent reminder to ${registration.email} for shift on ${formattedDate}`);
    } catch (error) {
      this.logger.error(`Failed to send reminder to ${registration.email}:`, error);
    }
  }
}
