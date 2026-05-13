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
  AdminCreateRegistrationDto,
  AdminUpdateRegistrationDto,
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
      requiredWorkers: dto.requiredWorkers ?? 1,
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

    // Required workers lives on the job; cascade to all of its shifts so the
    // public-side `confirmedCount / requiredWorkers` reading stays in sync.
    if (dto.requiredWorkers !== undefined && dto.requiredWorkers !== job.requiredWorkers) {
      job.requiredWorkers = dto.requiredWorkers;
      await this.shiftRepository.update(
        { shiftJobId: job.id },
        { requiredWorkers: dto.requiredWorkers },
      );
    }

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
      // Required workers lives exclusively on the job; per-shift override has
      // been removed by product decision (admins manage it at job level only).
      requiredWorkers: job.requiredWorkers ?? 1,
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
    // dto.requiredWorkers is intentionally ignored — workers are job-level only.
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
        // Required workers is job-level only.
        requiredWorkers: job.requiredWorkers ?? 1,
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

  /** Admin adds a helper directly to a shift (no email verification step).
   *  Resulting registration is immediately confirmed. */
  async adminCreateRegistration(
    organizationId: string,
    shiftId: string,
    dto: AdminCreateRegistrationDto,
  ): Promise<ShiftRegistration> {
    const shift = await this.shiftRepository.findOne({
      where: { id: shiftId },
      relations: ['job', 'job.shiftPlan', 'registrations'],
    });

    if (!shift || shift.job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Schicht nicht gefunden');
    }

    const reg = this.registrationRepository.create({
      shiftId: shift.id,
      // Append to an existing helper-group when the caller supplied one;
      // otherwise start a new group (= a fresh standalone helper).
      registrationGroupId: dto.registrationGroupId ?? uuidv4(),
      name: dto.name,
      email: dto.email,
      phone: dto.phone || null,
      notes: dto.notes || null,
      adminNotes: dto.adminNotes || null,
      status: ShiftRegistrationStatus.CONFIRMED,
      verificationToken: this.generateToken(),
    });

    const saved = await this.registrationRepository.save(reg);

    if (dto.notify) {
      const full = await this.registrationRepository.findOne({
        where: { id: saved.id },
        relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
      });
      if (full) {
        const summary = this.formatShiftsSummary([full]);
        await this.emailService.sendShiftConfirmationEmail(
          full.email,
          full.name,
          full.shift.job.shiftPlan.name,
          summary,
        );
      }
    }

    return saved;
  }

  /** Admin edits a registration. Setting `shiftId` to a different value
   *  moves the helper to that shift; by default the helper gets a
   *  notification email summarising the change. */
  async adminUpdateRegistration(
    organizationId: string,
    registrationId: string,
    dto: AdminUpdateRegistrationDto,
  ): Promise<ShiftRegistration> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);

    // Capture the pre-change shift snapshot for the notification email.
    const oldShiftLine = reg.shift
      ? this.formatShiftsSummary([reg]).replace(/<\/?p[^>]*>/g, '').trim()
      : '';

    if (dto.name !== undefined) reg.name = dto.name;
    if (dto.email !== undefined) reg.email = dto.email;
    if (dto.phone !== undefined) reg.phone = dto.phone || null;
    if (dto.notes !== undefined) reg.notes = dto.notes || null;
    if (dto.adminNotes !== undefined) reg.adminNotes = dto.adminNotes || null;

    let shiftMoved = false;
    if (dto.shiftId && dto.shiftId !== reg.shiftId) {
      const targetShift = await this.shiftRepository.findOne({
        where: { id: dto.shiftId },
        relations: ['job', 'job.shiftPlan'],
      });
      if (!targetShift || targetShift.job.shiftPlan.organizationId !== organizationId) {
        throw new NotFoundException('Ziel-Schicht nicht gefunden');
      }
      if (targetShift.job.shiftPlanId !== reg.shift?.job?.shiftPlanId) {
        throw new BadRequestException('Schicht muss zum selben Schichtplan gehören');
      }
      reg.shiftId = targetShift.id;
      shiftMoved = true;
    }

    const saved = await this.registrationRepository.save(reg);

    if (shiftMoved && (dto.notify ?? true)) {
      const full = await this.registrationRepository.findOne({
        where: { id: saved.id },
        relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
      });
      if (full) {
        const newShiftLine = this.formatShiftsSummary([full]).replace(/<\/?p[^>]*>/g, '').trim();
        await this.emailService.sendShiftUpdatedEmail(
          full.email,
          full.name,
          full.shift.job.shiftPlan.name,
          oldShiftLine,
          newShiftLine,
          dto.notifyMessage,
        );
      }
    }

    return saved;
  }

  /** Admin proposes a shift move; the helper gets an email with accept/decline
   *  links. The original shiftId stays put until the helper accepts. */
  async proposeShiftMove(
    organizationId: string,
    registrationId: string,
    targetShiftId: string,
    message: string | undefined,
    baseUrl?: string,
  ): Promise<ShiftRegistration> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);

    const targetShift = await this.shiftRepository.findOne({
      where: { id: targetShiftId },
      relations: ['job', 'job.shiftPlan'],
    });
    if (!targetShift || targetShift.job.shiftPlan.organizationId !== organizationId) {
      throw new NotFoundException('Ziel-Schicht nicht gefunden');
    }
    if (targetShift.job.shiftPlanId !== reg.shift?.job?.shiftPlanId) {
      throw new BadRequestException('Schicht muss zum selben Schichtplan gehören');
    }
    if (targetShiftId === reg.shiftId) {
      throw new BadRequestException('Diese Schicht ist bereits zugewiesen');
    }

    reg.proposedShiftId = targetShift.id;
    reg.proposedAt = new Date();
    reg.proposedMessage = message ?? null;
    reg.proposedToken = this.generateToken();
    const saved = await this.registrationRepository.save(reg);

    const planName = reg.shift?.job?.shiftPlan?.name || 'Schichtplan';
    const oldShiftLine = reg.shift
      ? `${reg.shift.job.name}: ${this.formatShiftDate(reg.shift.date)}, ${reg.shift.startTime}–${reg.shift.endTime}`
      : '';
    const newShiftLine = `${targetShift.job.name}: ${this.formatShiftDate(targetShift.date)}, ${targetShift.startTime}–${targetShift.endTime}`;
    const proposalBase = baseUrl || this.emailService.appUrl;
    const acceptUrl = `${proposalBase}/s/proposal/${reg.proposedToken}?action=accept`;
    const declineUrl = `${proposalBase}/s/proposal/${reg.proposedToken}?action=decline`;

    await this.emailService.sendShiftMoveProposalEmail({
      to: reg.email,
      name: reg.name,
      shiftPlanName: planName,
      oldShiftLine,
      newShiftLine,
      message,
      acceptUrl,
      declineUrl,
    });

    return saved;
  }

  /** Public: helper acts on a proposal by clicking the email link. */
  async respondToShiftProposal(
    token: string,
    action: 'accept' | 'decline',
  ): Promise<{ status: 'accepted' | 'declined'; planSlug: string | null }> {
    const reg = await this.registrationRepository.findOne({
      where: { proposedToken: token },
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan', 'proposedShift', 'proposedShift.job', 'proposedShift.job.shiftPlan'],
    });
    if (!reg || !reg.proposedShiftId) {
      throw new NotFoundException('Vorschlag nicht gefunden oder bereits bearbeitet');
    }

    const planSlug = reg.shift?.job?.shiftPlan?.publicSlug || null;

    if (action === 'accept') {
      reg.shiftId = reg.proposedShiftId;
    }
    reg.proposedShiftId = null;
    reg.proposedAt = null;
    reg.proposedMessage = null;
    reg.proposedToken = null;
    await this.registrationRepository.save(reg);

    return { status: action === 'accept' ? 'accepted' : 'declined', planSlug };
  }

  /** Small helper for the proposal email — formats a date as DD.MM.YYYY. */
  private formatShiftDate(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
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
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
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

  /** Remove a single shift from a helper's group, leaving the helper's other
   *  shifts intact. If the deleted row was the last in the group, the group
   *  disappears too — but that's just a side-effect of removing the last row. */
  async removeSingleRegistration(organizationId: string, registrationId: string): Promise<void> {
    const reg = await this.findRegistrationWithAccess(organizationId, registrationId);
    await this.registrationRepository.delete({ id: reg.id });
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
      relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
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
        relations: ['shift', 'shift.job', 'shift.job.shiftPlan'],
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
