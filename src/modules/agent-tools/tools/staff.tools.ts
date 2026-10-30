import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  ShiftPlanStatus,
  ShiftRegistrationStatus,
  type Shift,
  type ShiftJob,
  type ShiftPlan,
} from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { OrganizationsService } from '../../organizations/organizations.service';
import type { CreateShiftDto, CreateShiftJobDto, CreateShiftPlanDto } from '../../shifts/dto';
import { ShiftsService } from '../../shifts/shifts.service';
import { AgentToolError, defineTool, type AgentTool, type AgentToolContext } from '../agent-tool.types';
import { confirmInput, defined, done, hexColor, isoDate, preview, uuid } from '../tool-helpers';

const TIME = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function registrationCounts(shifts: Shift[]) {
  const counts = { confirmed: 0, pendingApproval: 0, pendingEmail: 0, rejected: 0, cancelled: 0 };
  for (const shift of shifts) {
    for (const r of shift.registrations ?? []) {
      if (r.status === ShiftRegistrationStatus.CONFIRMED) counts.confirmed++;
      else if (r.status === ShiftRegistrationStatus.PENDING_APPROVAL) counts.pendingApproval++;
      else if (r.status === ShiftRegistrationStatus.PENDING_EMAIL) counts.pendingEmail++;
      else if (r.status === ShiftRegistrationStatus.REJECTED) counts.rejected++;
      else if (r.status === ShiftRegistrationStatus.CANCELLED) counts.cancelled++;
    }
  }
  return counts;
}

function compactShift(shift: Shift) {
  const c = registrationCounts([shift]);
  return {
    id: shift.id,
    date: isoDate(shift.date),
    startTime: String(shift.startTime).slice(0, 5),
    endTime: String(shift.endTime).slice(0, 5),
    requiredWorkers: shift.requiredWorkers,
    confirmed: c.confirmed,
    pending: c.pendingApproval + c.pendingEmail,
    notes: shift.notes ?? null,
  };
}

function compactJob(job: ShiftJob, withShifts: boolean) {
  const shifts = job.shifts ?? [];
  return {
    id: job.id,
    name: job.name,
    description: job.description ?? null,
    color: job.color ?? null,
    requiredWorkers: job.requiredWorkers,
    sortOrder: job.sortOrder,
    shiftCount: shifts.length,
    ...(withShifts ? { shifts: shifts.map(compactShift) } : {}),
  };
}

function compactPlan(plan: ShiftPlan) {
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    eventId: plan.eventId ?? null,
    eventName: plan.event?.name ?? null,
    publicSlug: plan.publicSlug,
    jobCount: plan.jobs?.length ?? 0,
    createdAt: plan.createdAt?.toISOString?.() ?? null,
  };
}

@Injectable()
export class StaffTools {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly organizations: OrganizationsService,
  ) {}

  tools(): AgentTool[] {
    return [
      this.listPlans(),
      this.getPlan(),
      this.createPlan(),
      this.createJob(),
      this.createShifts(),
      this.publishPlan(),
    ];
  }

  /* Der Schichten-Dienst prueft keine Modul-Berechtigung selbst (der
     REST-Controller nur die Mitgliedschaft). Hier gilt die Tabelle aus
     ki-plan.md 8.3: lesen = Mitglied, schreiben = Admin oder `shiftPlans`. */
  private canRead(ctx: AgentToolContext) {
    return this.organizations.checkMembership(ctx.organizationId, ctx.user);
  }
  private canWrite(ctx: AgentToolContext) {
    return this.organizations.checkPermission(ctx.organizationId, ctx.user, 'shiftPlans');
  }

  private listPlans() {
    return defineTool({
      name: 'list_shift_plans',
      description: 'Shift plans (helper schedules) of the organization: status draft/published/closed, linked event, job count.',
      inputSchema: z.object({ status: z.nativeEnum(ShiftPlanStatus).optional() }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        await this.canRead(ctx);
        let plans = await this.shifts.findAllPlans(ctx.organizationId);
        if (input.status) plans = plans.filter((p) => p.status === input.status);
        return { items: plans.map(compactPlan), total: plans.length };
      },
    });
  }

  private getPlan() {
    return defineTool({
      name: 'get_shift_plan',
      description: 'One shift plan with jobs, shifts and registration counts (no helper names or contact data).',
      inputSchema: z.object({ planId: uuid }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        await this.canRead(ctx);
        const plan = await this.shifts.findOnePlan(ctx.organizationId, input.planId);
        const jobs = [...(plan.jobs ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
        const allShifts = jobs.flatMap((j) => j.shifts ?? []);
        return {
          ...compactPlan(plan),
          description: plan.description ?? null,
          settings: plan.settings,
          shiftCount: allShifts.length,
          registrations: registrationCounts(allShifts),
          jobs: jobs.map((j) => compactJob(j, true)),
        };
      },
    });
  }

  private createPlan() {
    return defineTool({
      name: 'create_shift_plan',
      description: 'Create a shift plan (starts as draft). Optionally link it to an event.',
      inputSchema: z
        .object({
          name: z.string().min(1).max(255),
          description: z.string().max(2000).optional(),
          eventId: uuid.optional(),
          requireApproval: z.boolean().optional().describe('Default true'),
          allowMultipleShifts: z.boolean().optional().describe('Default true'),
          maxShiftsPerPerson: z.number().int().min(0).optional().describe('0 = unlimited'),
          reminderDaysBefore: z.number().int().min(0).max(30).optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.STAFF_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...rest } = input;
        await this.canWrite(ctx);
        const dto = defined(rest) as CreateShiftPlanDto;
        if (!confirm) {
          return preview(`Würde Schichtplan „${dto.name}“ (Entwurf) anlegen`, { wouldCreate: dto });
        }
        const plan = await this.shifts.createPlan(ctx.organizationId, dto);
        return done(`Schichtplan „${plan.name}“ angelegt (Entwurf)`, { plan: compactPlan(plan) });
      },
    });
  }

  private createJob() {
    return defineTool({
      name: 'create_shift_job',
      description: 'Add a job (station/task such as "Theke", "Grill") to a shift plan.',
      inputSchema: z
        .object({
          planId: uuid,
          name: z.string().min(1).max(100),
          description: z.string().max(2000).optional(),
          color: hexColor.optional(),
          requiredWorkers: z.number().int().min(1).optional().describe('Helpers per shift (default 1)'),
          sortOrder: z.number().int().min(0).optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.STAFF_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { planId, confirm, ...rest } = input;
        await this.canWrite(ctx);
        const plan = await this.shifts.findOnePlan(ctx.organizationId, planId);
        const dto = defined(rest) as CreateShiftJobDto;
        if (!confirm) {
          return preview(`Würde Arbeit „${dto.name}“ in „${plan.name}“ anlegen`, { wouldCreate: dto });
        }
        const job = await this.shifts.createJob(ctx.organizationId, planId, dto);
        return done(`Arbeit „${job.name}“ in „${plan.name}“ angelegt`, { job: compactJob(job, false) });
      },
    });
  }

  private createShifts() {
    return defineTool({
      name: 'create_shifts',
      description:
        'Add up to 100 shifts (time slots) to a job. date YYYY-MM-DD, times HH:mm; endTime before startTime means past midnight. requiredWorkers comes from the job. Exact duplicates of existing shifts are skipped.',
      inputSchema: z
        .object({
          jobId: uuid,
          shifts: z
            .array(
              z
                .object({
                  date: z.string().regex(DAY),
                  startTime: z.string().regex(TIME),
                  endTime: z.string().regex(TIME),
                  notes: z.string().max(500).optional(),
                })
                .strict(),
            )
            .min(1)
            .max(100),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.STAFF_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        await this.canWrite(ctx);
        const existing = await this.shifts.findAllShifts(ctx.organizationId, input.jobId);
        const key = (s: { date: string | Date; startTime: string; endTime: string }) =>
          `${isoDate(s.date)}|${String(s.startTime).slice(0, 5)}|${String(s.endTime).slice(0, 5)}`;
        const taken = new Set(existing.map(key));
        const fresh: CreateShiftDto[] = [];
        const skipped: string[] = [];
        for (const shift of input.shifts) {
          const k = key(shift);
          if (taken.has(k)) {
            skipped.push(k);
            continue;
          }
          taken.add(k);
          fresh.push(defined(shift) as CreateShiftDto);
        }
        if (!input.confirm) {
          return preview(
            `Würde ${fresh.length} Schichten anlegen` + (skipped.length ? ` (${skipped.length} gibt es schon)` : ''),
            { wouldCreate: fresh, skipped },
          );
        }
        if (fresh.length === 0) {
          throw new AgentToolError('CONFLICT', 'Alle Schichten gibt es schon', skipped);
        }
        const created = await this.shifts.createShiftsBulk(ctx.organizationId, input.jobId, fresh);
        return done(`${created.length} Schichten angelegt` + (skipped.length ? `, ${skipped.length} übersprungen` : ''), {
          shifts: created.map(compactShift),
          skipped,
        });
      },
    });
  }

  private publishPlan() {
    return defineTool({
      name: 'publish_shift_plan',
      description:
        'Publish a shift plan: makes the public helper link active so helpers can register. Preview shows job and shift counts.',
      inputSchema: z.object({ planId: uuid, ...confirmInput }).strict(),
      scope: TokenScope.STAFF_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        await this.canWrite(ctx);
        const plan = await this.shifts.findOnePlan(ctx.organizationId, input.planId);
        if (plan.status === ShiftPlanStatus.PUBLISHED) {
          throw new AgentToolError('CONFLICT', `Schichtplan „${plan.name}“ ist schon veröffentlicht`);
        }
        const jobs = plan.jobs ?? [];
        const shiftCount = jobs.reduce((n, j) => n + (j.shifts?.length ?? 0), 0);
        const warning = shiftCount === 0 ? 'Der Plan hat noch keine Schichten.' : null;
        if (!input.confirm) {
          return preview(
            `Würde Schichtplan „${plan.name}“ veröffentlichen (${jobs.length} Arbeiten, ${shiftCount} Schichten)` +
              (warning ? ` — ${warning}` : ''),
            { plan: compactPlan(plan), shiftCount, warning },
          );
        }
        const published = await this.shifts.publishPlan(ctx.organizationId, input.planId);
        return done(`Schichtplan „${published.name}“ veröffentlicht`, {
          plan: compactPlan(published),
          publicPath: `/s/${published.publicSlug}`,
        });
      },
    });
  }
}
