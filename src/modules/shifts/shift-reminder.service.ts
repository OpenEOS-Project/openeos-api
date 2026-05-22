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

  // ============ Verification reminders for unconfirmed helpers ============

  /**
   * Runs hourly and nudges helpers who registered but didn't click the
   * verification link. Per-plan settings: enabled flag, interval (h),
   * and a max-count so we don't spam someone forever.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleVerificationReminders() {
    this.logger.log('Starting verification-reminder job...');
    try {
      const plans = await this.shiftPlanRepository.find({
        where: { status: ShiftPlanStatus.PUBLISHED },
      });
      const baseUrl = this.emailService.appUrl;

      for (const plan of plans) {
        const enabled = plan.settings?.verificationReminderEnabled ?? true;
        if (!enabled) continue;
        const intervalH = Math.max(1, plan.settings?.verificationReminderIntervalHours ?? 24);
        const maxCount = Math.max(0, plan.settings?.verificationReminderMaxCount ?? 5);
        if (maxCount === 0) continue;

        const cutoff = new Date(Date.now() - intervalH * 60 * 60 * 1000);

        // Pull pending_email rows for this plan that haven't hit the cap and
        // are due for the next nudge (lastVerificationReminderAt < cutoff,
        // or never sent).
        const candidates = await this.registrationRepository
          .createQueryBuilder('reg')
          .innerJoin('reg.shift', 'shift')
          .innerJoin('shift.job', 'job')
          .where('job.shiftPlanId = :planId', { planId: plan.id })
          .andWhere('reg.status = :status', { status: ShiftRegistrationStatus.PENDING_EMAIL })
          .andWhere('reg.verificationReminderCount < :max', { max: maxCount })
          .andWhere('(reg.lastVerificationReminderAt IS NULL OR reg.lastVerificationReminderAt < :cutoff)', { cutoff })
          .getMany();

        // Dedupe by registrationGroupId so a multi-shift signup gets ONE
        // mail per cycle, not one per shift.
        const byGroup = new Map<string, ShiftRegistration>();
        for (const c of candidates) {
          if (!byGroup.has(c.registrationGroupId)) byGroup.set(c.registrationGroupId, c);
        }

        for (const reg of byGroup.values()) {
          try {
            const verifyUrl = `${baseUrl}/s/verify/${reg.verificationToken}`;
            await this.emailService.sendVerificationReminderEmail(
              reg.email, reg.name, plan.name, verifyUrl,
              reg.verificationReminderCount + 1, maxCount,
            );
            // Bump the counter on every row of the helper's group so the
            // dedupe stays sane next cycle.
            const now = new Date();
            await this.registrationRepository
              .createQueryBuilder()
              .update(ShiftRegistration)
              .set({
                verificationReminderCount: () => '"verification_reminder_count" + 1',
                lastVerificationReminderAt: now,
              })
              .where('registration_group_id = :gid', { gid: reg.registrationGroupId })
              .execute();
            this.logger.log(
              `Verification reminder ${reg.verificationReminderCount + 1}/${maxCount} sent to ${reg.email}`,
            );
          } catch (err) {
            this.logger.error(`Failed verification reminder for ${reg.email}: ${(err as Error).message}`);
          }
        }
      }

      this.logger.log('Verification-reminder job completed');
    } catch (err) {
      this.logger.error(`Verification-reminder job failed: ${(err as Error).message}`);
    }
  }
}
