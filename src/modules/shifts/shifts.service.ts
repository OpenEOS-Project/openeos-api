import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  ShiftPlan,
  ShiftPlanStatus,
  ShiftJob,
  Shift,
  ShiftRegistration,
  ShiftRegistrationStatus,
  User,
} from '../../database/entities';
import { EmailService } from '../email/email.service';
import {
  CreateShiftPlanDto,
  UpdateShiftPlanDto,
  CreateShiftJobDto,
  UpdateShiftJobDto,
  CreateShiftDto,
  UpdateShiftDto,
} from './dto';

@Injectable()
export class ShiftsService {
  constructor(
    @InjectRepository(ShiftPlan)
    private readonly shiftPlanRepository: Repository<ShiftPlan>,
    @InjectRepository(ShiftJob)
    private readonly shiftJobRepository: Repository<ShiftJob>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    @InjectRepository(ShiftRegistration)
    private readonly registrationRepository: Repository<ShiftRegistration>,
    private readonly emailService: EmailService,
  ) {}

  // ============ Shift Plans ============

  async createPlan(organizationId: string, dto: CreateShiftPlanDto): Promise<ShiftPlan> {
    const slug = dto.publicSlug || this.generateSlug(dto.name);

    // Check slug uniqueness
    const existingSlug = await this.shiftPlanRepository.findOne({ where: { publicSlug: slug } });
    if (existingSlug) {
      throw new BadRequestException('Der URL-Slug ist bereits vergeben. Bitte wähle einen anderen.');
    }

    const plan = this.shiftPlanRepository.create({
      organizationId,
      name: dto.name,
      description: dto.description,
      eventId: dto.eventId || null,
      publicSlug: slug,
      settings: {
        requireApproval: dto.requireApproval ?? true,
        allowMultipleShifts: dto.allowMultipleShifts ?? true,
        reminderDaysBefore: dto.reminderDaysBefore ?? 1,
        maxShiftsPerPerson: dto.maxShiftsPerPerson,
      },
    });

    return this.shiftPlanRepository.save(plan);
  }

  async findAllPlans(organizationId: string): Promise<ShiftPlan[]> {
    return this.shiftPlanRepository.find({
      where: { organizationId },
      relations: ['event', 'jobs'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOnePlan(organizationId: string, planId: string): Promise<ShiftPlan> {
    const plan = await this.shiftPlanRepository.findOne({
      where: { id: planId, organizationId },
      relations: ['event', 'jobs', 'jobs.shifts', 'jobs.shifts.registrations'],
    });

    if (!plan) {
      throw new NotFoundException('Schichtplan nicht gefunden');
    }

    return plan;
  }

  async updatePlan(organizationId: string, planId: string, dto: UpdateShiftPlanDto): Promise<ShiftPlan> {
    const plan = await this.findOnePlan(organizationId, planId);

    if (dto.publicSlug && dto.publicSlug !== plan.publicSlug) {
      const existingSlug = await this.shiftPlanRepository.findOne({ where: { publicSlug: dto.publicSlug } });
      if (existingSlug) {
        throw new BadRequestException('Der URL-Slug ist bereits vergeben.');
      }
      plan.publicSlug = dto.publicSlug;
    }

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.eventId !== undefined) plan.eventId = dto.eventId;

    // Update settings
    if (dto.requireApproval !== undefined) plan.settings.requireApproval = dto.requireApproval;
    if (dto.allowMultipleShifts !== undefined) plan.settings.allowMultipleShifts = dto.allowMultipleShifts;
    if (dto.reminderDaysBefore !== undefined) plan.settings.reminderDaysBefore = dto.reminderDaysBefore;
    if (dto.maxShiftsPerPerson !== undefined) plan.settings.maxShiftsPerPerson = dto.maxShiftsPerPerson;

    return this.shiftPlanRepository.save(plan);
  }

  async deletePlan(organizationId: string, planId: string): Promise<void> {
    const plan = await this.findOnePlan(organizationId, planId);
    await this.shiftPlanRepository.remove(plan);
  }

  async publishPlan(organizationId: string, planId: string): Promise<ShiftPlan> {
    const plan = await this.findOnePlan(organizationId, planId);

    if (plan.status === ShiftPlanStatus.PUBLISHED) {
      throw new BadRequestException('Schichtplan ist bereits veröffentlicht');
    }

    plan.status = ShiftPlanStatus.PUBLISHED;
    return this.shiftPlanRepository.save(plan);
  }

  async closePlan(organizationId: string, planId: string): Promise<ShiftPlan> {
    const plan = await this.findOnePlan(organizationId, planId);
    plan.status = ShiftPlanStatus.CLOSED;
    return this.shiftPlanRepository.save(plan);
  }

  // ============ Jobs ============

  async createJob(organizationId: string, planId: string, dto: CreateShiftJobDto): Promise<ShiftJob> {
    const plan = await this.findOnePlan(organizationId, planId);

    // Get max sort order
    const maxOrder = await this.shiftJobRepository
      .createQueryBuilder('job')
      .where('job.shiftPlanId = :planId', { planId })
      .select('MAX(job.sortOrder)', 'max')
      .getRawOne();

    const job = this.shiftJobRepository.create({
      shiftPlanId: plan.id,
      name: dto.name,
      description: dto.description,
      color: dto.color,
      sortOrder: dto.sortOrder ?? (maxOrder?.max ?? 0) + 1,
    });

    return this.shiftJobRepository.save(job);
  }

  async findAllJobs(organizationId: string, planId: string): Promise<ShiftJob[]> {
    await this.findOnePlan(organizationId, planId); // Verify access

    return this.shiftJobRepository.find({
      where: { shiftPlanId: planId },
      relations: ['shifts', 'shifts.registrations'],
      order: { sortOrder: 'ASC' },
    });
  }

  async updateJob(organizationId: string, jobId: string, dto: UpdateShiftJobDto): Promise<ShiftJob> {
    const job = await this.shiftJobRepository.findOne({
      where: { id: jobId },
      relations: ['shiftPlan'],
    });

    if (!job || job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Job nicht gefunden');
    }

    if (dto.name !== undefined) job.name = dto.name;
    if (dto.description !== undefined) job.description = dto.description;
    if (dto.color !== undefined) job.color = dto.color;
    if (dto.sortOrder !== undefined) job.sortOrder = dto.sortOrder;

    return this.shiftJobRepository.save(job);
  }

  async deleteJob(organizationId: string, jobId: string): Promise<void> {
    const job = await this.shiftJobRepository.findOne({
      where: { id: jobId },
      relations: ['shiftPlan'],
    });

    if (!job || job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Job nicht gefunden');
    }

    await this.shiftJobRepository.remove(job);
  }

  // ============ Shifts ============

  async createShift(organizationId: string, jobId: string, dto: CreateShiftDto): Promise<Shift> {
    const job = await this.shiftJobRepository.findOne({
      where: { id: jobId },
      relations: ['shiftPlan'],
    });

    if (!job || job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Job nicht gefunden');
    }

    const shift = this.shiftRepository.create({
      shiftJobId: job.id,
      date: new Date(dto.date),
      startTime: dto.startTime,
      endTime: dto.endTime,
      requiredWorkers: dto.requiredWorkers ?? 1,
      notes: dto.notes,
    });

    return this.shiftRepository.save(shift);
  }

  async findAllShifts(organizationId: string, jobId: string): Promise<Shift[]> {
    const job = await this.shiftJobRepository.findOne({
      where: { id: jobId },
      relations: ['shiftPlan'],
    });

    if (!job || job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Job nicht gefunden');
    }

    return this.shiftRepository.find({
      where: { shiftJobId: jobId },
      relations: ['registrations'],
      order: { date: 'ASC', startTime: 'ASC' },
    });
  }

  async updateShift(organizationId: string, shiftId: string, dto: UpdateShiftDto): Promise<Shift> {
    const shift = await this.shiftRepository.findOne({
      where: { id: shiftId },
      relations: ['job', 'job.shiftPlan'],
    });

    if (!shift || shift.job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Schicht nicht gefunden');
    }

    if (dto.date !== undefined) shift.date = new Date(dto.date);
    if (dto.startTime !== undefined) shift.startTime = dto.startTime;
    if (dto.endTime !== undefined) shift.endTime = dto.endTime;
    if (dto.requiredWorkers !== undefined) shift.requiredWorkers = dto.requiredWorkers;
    if (dto.notes !== undefined) shift.notes = dto.notes;

    return this.shiftRepository.save(shift);
  }

  async deleteShift(organizationId: string, shiftId: string): Promise<void> {
    const shift = await this.shiftRepository.findOne({
      where: { id: shiftId },
      relations: ['job', 'job.shiftPlan'],
    });

    if (!shift || shift.job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Schicht nicht gefunden');
    }

    await this.shiftRepository.remove(shift);
  }

  async createShiftsBulk(
    organizationId: string,
    jobId: string,
    shifts: CreateShiftDto[],
  ): Promise<Shift[]> {
    const job = await this.shiftJobRepository.findOne({
      where: { id: jobId },
      relations: ['shiftPlan'],
    });

    if (!job || job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Job nicht gefunden');
    }

    const createdShifts: Shift[] = [];

    for (const dto of shifts) {
      const shift = this.shiftRepository.create({
        shiftJobId: job.id,
        date: new Date(dto.date),
        startTime: dto.startTime,
        endTime: dto.endTime,
        requiredWorkers: dto.requiredWorkers ?? 1,
        notes: dto.notes,
      });
      createdShifts.push(await this.shiftRepository.save(shift));
    }

    return createdShifts;
  }

  // ============ Registrations (Admin) ============

  async findAllRegistrations(organizationId: string, planId: string): Promise<ShiftRegistration[]> {
    await this.findOnePlan(organizationId, planId); // Verify access

    return this.registrationRepository
      .createQueryBuilder('reg')
      .innerJoin('reg.shift', 'shift')
      .innerJoin('shift.job', 'job')
      .where('job.shiftPlanId = :planId', { planId })
      .leftJoinAndSelect('reg.shift', 's')
      .leftJoinAndSelect('s.job', 'j')
      .orderBy('reg.createdAt', 'DESC')
      .getMany();
  }

  async approveRegistration(
    organizationId: string,
    registrationId: string,
    user: User,
    message?: string,
  ): Promise<ShiftRegistration> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);

    if (reg.status !== ShiftRegistrationStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Nur Anmeldungen mit Status "wartet auf Bestätigung" können bestätigt werden');
    }

    reg.status = ShiftRegistrationStatus.CONFIRMED;
    await this.registrationRepository.save(reg);

    // Find all registrations in the same group and confirm them
    const groupRegistrations = await this.registrationRepository.find({
      where: { registrationGroupId: reg.registrationGroupId },
      relations: ['shift', 'shift.job'],
    });

    for (const r of groupRegistrations) {
      if (r.status === ShiftRegistrationStatus.PENDING_APPROVAL) {
        r.status = ShiftRegistrationStatus.CONFIRMED;
        await this.registrationRepository.save(r);
      }
    }

    // Send confirmation email
    const shiftsSummary = this.formatShiftsSummary(groupRegistrations);
    const planName = groupRegistrations[0]?.shift?.job?.shiftPlan?.name || 'Schichtplan';

    await this.emailService.sendShiftConfirmationEmail(
      reg.email,
      reg.name,
      planName,
      shiftsSummary,
    );

    return reg;
  }

  async rejectRegistration(
    organizationId: string,
    registrationId: string,
    user: User,
    reason?: string,
  ): Promise<ShiftRegistration> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);

    // Reject all registrations in the same group
    const groupRegistrations = await this.registrationRepository.find({
      where: { registrationGroupId: reg.registrationGroupId },
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
    });

    for (const r of groupRegistrations) {
      r.status = ShiftRegistrationStatus.REJECTED;
      await this.registrationRepository.save(r);
    }

    // Send rejection email
    const planName = groupRegistrations[0]?.shift?.job?.shiftPlan?.name || 'Schichtplan';
    await this.emailService.sendShiftRejectionEmail(reg.email, reg.name, planName, reason);

    return reg;
  }

  async sendMessage(
    organizationId: string,
    registrationId: string,
    user: User,
    message: string,
  ): Promise<void> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);
    const planName = reg.shift?.job?.shiftPlan?.name || 'Schichtplan';

    await this.emailService.sendShiftMessageEmail(
      reg.email,
      reg.name,
      planName,
      message,
      user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
    );
  }

  async deleteRegistration(organizationId: string, registrationId: string): Promise<void> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);

    // Delete all registrations in the same group
    await this.registrationRepository.delete({ registrationGroupId: reg.registrationGroupId });
  }

  async updateRegistrationNotes(
    organizationId: string,
    registrationId: string,
    adminNotes: string,
  ): Promise<ShiftRegistration> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);
    reg.adminNotes = adminNotes;
    return this.registrationRepository.save(reg);
  }

  // ============ Public API ============

  async findPlanBySlug(slug: string): Promise<ShiftPlan> {
    const plan = await this.shiftPlanRepository.findOne({
      where: { publicSlug: slug, status: ShiftPlanStatus.PUBLISHED },
      relations: ['organization', 'event', 'jobs', 'jobs.shifts', 'jobs.shifts.registrations'],
    });

    if (!plan) {
      throw new NotFoundException('Schichtplan nicht gefunden oder nicht veröffentlicht');
    }

    return plan;
  }

  async publicRegister(
    slug: string,
    name: string,
    email: string,
    shiftIds: string[],
    phone?: string,
    notes?: string,
    baseUrl?: string,
  ): Promise<{ registrationGroupId: string; shiftsCount: number }> {
    const plan = await this.findPlanBySlug(slug);

    // Verify all shifts belong to this plan and have available spots
    const shifts = await this.shiftRepository.find({
      where: shiftIds.map((id) => ({ id })),
      relations: ['job', 'registrations'],
    });

    if (shifts.length !== shiftIds.length) {
      throw new BadRequestException('Eine oder mehrere Schichten wurden nicht gefunden');
    }

    for (const shift of shifts) {
      if (shift.job.shiftPlanId !== plan.id) {
        throw new BadRequestException('Schicht gehört nicht zu diesem Schichtplan');
      }

      // Check if shift is full (only count confirmed registrations)
      const confirmedCount = shift.registrations.filter(
        (r) => r.status === ShiftRegistrationStatus.CONFIRMED,
      ).length;

      if (confirmedCount >= shift.requiredWorkers) {
        throw new BadRequestException(`Schicht "${shift.job.name}" ist bereits voll belegt`);
      }
    }

    // Check max shifts per person if configured
    if (plan.settings.maxShiftsPerPerson && plan.settings.maxShiftsPerPerson > 0) {
      // Count existing registrations for this email
      const existingCount = await this.registrationRepository
        .createQueryBuilder('reg')
        .innerJoin('reg.shift', 'shift')
        .innerJoin('shift.job', 'job')
        .where('job.shiftPlanId = :planId', { planId: plan.id })
        .andWhere('reg.email = :email', { email })
        .andWhere('reg.status NOT IN (:...statuses)', {
          statuses: [ShiftRegistrationStatus.REJECTED, ShiftRegistrationStatus.CANCELLED],
        })
        .getCount();

      if (existingCount + shiftIds.length > plan.settings.maxShiftsPerPerson) {
        throw new BadRequestException(
          `Du kannst dich maximal für ${plan.settings.maxShiftsPerPerson} Schichten anmelden`,
        );
      }
    }

    // Generate verification token and group ID
    const verificationToken = this.generateToken();
    const registrationGroupId = uuidv4();

    // Create registrations for all selected shifts
    const registrations: ShiftRegistration[] = [];
    for (const shift of shifts) {
      const registration = this.registrationRepository.create({
        shiftId: shift.id,
        registrationGroupId,
        name,
        email,
        phone: phone || null,
        notes: notes || null,
        status: ShiftRegistrationStatus.PENDING_EMAIL,
        verificationToken: registrations.length === 0 ? verificationToken : this.generateToken(),
      });
      registrations.push(await this.registrationRepository.save(registration));
    }

    // Load full relations for email
    const fullRegistrations = await this.registrationRepository.find({
      where: { registrationGroupId },
      relations: ['shift', 'shift.job'],
    });

    // Send verification email
    const shiftsSummary = this.formatShiftsSummary(fullRegistrations);
    const verifyUrl = baseUrl
      ? `${baseUrl}/s/verify/${verificationToken}`
      : `https://app.openeos.de/s/verify/${verificationToken}`;

    await this.emailService.sendShiftVerificationEmail(
      email,
      name,
      plan.name,
      shiftsSummary,
      verifyUrl,
    );

    return {
      registrationGroupId,
      shiftsCount: shiftIds.length,
    };
  }

  async verifyEmail(token: string): Promise<{ status: string; planSlug: string }> {
    const registration = await this.registrationRepository.findOne({
      where: { verificationToken: token },
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
    });

    if (!registration) {
      throw new NotFoundException('Ungültiger Verifizierungslink');
    }

    if (registration.emailVerifiedAt) {
      // Already verified
      return {
        status: registration.status,
        planSlug: registration.shift.job.shiftPlan.publicSlug,
      };
    }

    const plan = registration.shift.job.shiftPlan;
    const now = new Date();

    // Update all registrations in the group
    await this.registrationRepository.update(
      { registrationGroupId: registration.registrationGroupId },
      {
        emailVerifiedAt: now,
        status: plan.settings.requireApproval
          ? ShiftRegistrationStatus.PENDING_APPROVAL
          : ShiftRegistrationStatus.CONFIRMED,
      },
    );

    // If no approval required, send confirmation email
    if (!plan.settings.requireApproval) {
      const groupRegistrations = await this.registrationRepository.find({
        where: { registrationGroupId: registration.registrationGroupId },
        relations: ['shift', 'shift.job'],
      });

      const shiftsSummary = this.formatShiftsSummary(groupRegistrations);
      await this.emailService.sendShiftConfirmationEmail(
        registration.email,
        registration.name,
        plan.name,
        shiftsSummary,
      );
    }

    return {
      status: plan.settings.requireApproval
        ? ShiftRegistrationStatus.PENDING_APPROVAL
        : ShiftRegistrationStatus.CONFIRMED,
      planSlug: plan.publicSlug,
    };
  }

  // ============ Helpers ============

  private generateToken(): string {
    return [...Array(64)]
      .map(() => Math.random().toString(36).charAt(2))
      .join('');
  }

  private async findRegistrationWithAccess(
    organizationId: string,
    registrationId: string,
  ): Promise<ShiftRegistration> {
    const reg = await this.registrationRepository.findOne({
      where: { id: registrationId },
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
    });

    if (!reg || reg.shift.job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Anmeldung nicht gefunden');
    }

    return reg;
  }

  private generateSlug(name: string): string {
    const baseSlug = name
      .toLowerCase()
      .replace(/[äÄ]/g, 'ae')
      .replace(/[öÖ]/g, 'oe')
      .replace(/[üÜ]/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Add random suffix for uniqueness
    const suffix = Math.random().toString(36).substring(2, 6);
    return `${baseSlug}-${suffix}`;
  }

  private formatShiftsSummary(registrations: ShiftRegistration[]): string {
    return registrations
      .map((r) => {
        const shift = r.shift;
        const job = shift?.job;
        if (!shift || !job) return '';

        const date = new Date(shift.date).toLocaleDateString('de-DE', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });

        return `<p><strong>${job.name}</strong>: ${date}, ${shift.startTime} - ${shift.endTime} Uhr</p>`;
      })
      .filter(Boolean)
      .join('');
  }
}
