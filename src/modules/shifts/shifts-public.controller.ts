import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Headers,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { PublicRegisterDto } from './dto';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Shifts (Public)')
@Controller('public/shifts')
@Public()
export class ShiftsPublicController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get(':slug')
  @ApiOperation({ summary: 'Get public shift plan by slug' })
  async getShiftPlan(@Param('slug') slug: string) {
    const plan = await this.shiftsService.findPlanBySlug(slug);

    // Transform data for public consumption
    const publicPlan = {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      organization: {
        name: plan.organization?.name || '',
        logoUrl: plan.organization?.logoUrl || null,
      },
      event: plan.event
        ? {
            name: plan.event.name,
            startDate: plan.event.startDate,
            endDate: plan.event.endDate,
          }
        : null,
      settings: {
        allowMultipleShifts: plan.settings.allowMultipleShifts,
        maxShiftsPerPerson: plan.settings.maxShiftsPerPerson,
      },
      jobs: plan.jobs
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((job) => ({
          id: job.id,
          name: job.name,
          description: job.description,
          color: job.color,
          shifts: job.shifts
            .sort((a, b) => {
              const dateCompare = new Date(a.date).getTime() - new Date(b.date).getTime();
              if (dateCompare !== 0) return dateCompare;
              return a.startTime.localeCompare(b.startTime);
            })
            .map((shift) => {
              const confirmedCount = shift.registrations?.filter(
                (r) => r.status === 'confirmed',
              ).length || 0;

              return {
                id: shift.id,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                requiredWorkers: shift.requiredWorkers,
                confirmedCount,
                availableSpots: Math.max(0, shift.requiredWorkers - confirmedCount),
                isFull: confirmedCount >= shift.requiredWorkers,
              };
            }),
        })),
    };

    return { data: publicPlan };
  }

  @Post(':slug/register')
  @ApiOperation({ summary: 'Register for shift(s)' })
  async register(
    @Param('slug') slug: string,
    @Body() dto: PublicRegisterDto,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    // Determine base URL for verification link
    let baseUrl = origin;
    if (!baseUrl && referer) {
      try {
        const url = new URL(referer);
        baseUrl = `${url.protocol}//${url.host}`;
      } catch {
        // Ignore invalid referer
      }
    }

    const result = await this.shiftsService.publicRegister(
      slug,
      dto.name,
      dto.email,
      dto.shiftIds,
      dto.phone,
      dto.notes,
      baseUrl,
    );

    return {
      data: {
        success: true,
        message: 'Anmeldung erfolgreich. Bitte bestätige deine E-Mail-Adresse.',
        registrationGroupId: result.registrationGroupId,
        shiftsCount: result.shiftsCount,
      },
    };
  }

  @Get('verify/:token')
  @ApiOperation({ summary: 'Verify email address' })
  async verifyEmail(@Param('token') token: string) {
    const result = await this.shiftsService.verifyEmail(token);

    const messages: Record<string, string> = {
      pending_approval: 'E-Mail bestätigt! Deine Anmeldung wird nun geprüft.',
      confirmed: 'E-Mail bestätigt! Deine Schicht(en) sind bestätigt.',
    };

    return {
      data: {
        success: true,
        status: result.status,
        message: messages[result.status] || 'E-Mail bestätigt!',
        planSlug: result.planSlug,
      },
    };
  }
}
