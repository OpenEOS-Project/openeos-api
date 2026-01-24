import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { ShiftPdfService } from './shift-pdf.service';
import {
  CreateShiftPlanDto,
  UpdateShiftPlanDto,
  CreateShiftJobDto,
  UpdateShiftJobDto,
  CreateShiftDto,
  UpdateShiftDto,
  ApproveRegistrationDto,
  RejectRegistrationDto,
  SendMessageDto,
  UpdateRegistrationNotesDto,
} from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Shift Plans')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/shift-plans')
export class ShiftsController {
  constructor(
    private readonly shiftsService: ShiftsService,
    private readonly pdfService: ShiftPdfService,
  ) {}

  // ============ Shift Plans ============

  @Post()
  async createPlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateShiftPlanDto,
  ) {
    const plan = await this.shiftsService.createPlan(organizationId, dto);
    return { data: plan };
  }

  @Get()
  async findAllPlans(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const plans = await this.shiftsService.findAllPlans(organizationId);
    return { data: plans };
  }

  @Get(':planId')
  async findOnePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.findOnePlan(organizationId, planId);
    return { data: plan };
  }

  @Patch(':planId')
  async updatePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateShiftPlanDto,
  ) {
    const plan = await this.shiftsService.updatePlan(organizationId, planId, dto);
    return { data: plan };
  }

  @Delete(':planId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    await this.shiftsService.deletePlan(organizationId, planId);
  }

  @Post(':planId/publish')
  async publishPlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.publishPlan(organizationId, planId);
    return { data: plan };
  }

  @Post(':planId/close')
  async closePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.closePlan(organizationId, planId);
    return { data: plan };
  }

  @Get(':planId/export/pdf')
  async exportPdf(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const plan = await this.shiftsService.findOnePlan(organizationId, planId);
    const pdfBuffer = await this.pdfService.generateShiftPlanPdf(plan);

    // Generate a safe filename
    const filename = `${plan.name.replace(/[^a-zA-Z0-9äöüÄÖÜß\-_]/g, '_')}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    return new StreamableFile(pdfBuffer);
  }

  // ============ Jobs ============

  @Post(':planId/jobs')
  async createJob(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreateShiftJobDto,
  ) {
    const job = await this.shiftsService.createJob(organizationId, planId, dto);
    return { data: job };
  }

  @Get(':planId/jobs')
  async findAllJobs(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const jobs = await this.shiftsService.findAllJobs(organizationId, planId);
    return { data: jobs };
  }

  @Patch('jobs/:jobId')
  async updateJob(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: UpdateShiftJobDto,
  ) {
    const job = await this.shiftsService.updateJob(organizationId, jobId, dto);
    return { data: job };
  }

  @Delete('jobs/:jobId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteJob(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    await this.shiftsService.deleteJob(organizationId, jobId);
  }

  // ============ Shifts ============

  @Post('jobs/:jobId/shifts')
  async createShift(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: CreateShiftDto,
  ) {
    const shift = await this.shiftsService.createShift(organizationId, jobId, dto);
    return { data: shift };
  }

  @Post('jobs/:jobId/shifts/bulk')
  async createShiftsBulk(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: { shifts: CreateShiftDto[] },
  ) {
    const shifts = await this.shiftsService.createShiftsBulk(organizationId, jobId, dto.shifts);
    return { data: shifts };
  }

  @Get('jobs/:jobId/shifts')
  async findAllShifts(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    const shifts = await this.shiftsService.findAllShifts(organizationId, jobId);
    return { data: shifts };
  }

  @Patch('shifts/:shiftId')
  async updateShift(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: UpdateShiftDto,
  ) {
    const shift = await this.shiftsService.updateShift(organizationId, shiftId, dto);
    return { data: shift };
  }

  @Delete('shifts/:shiftId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteShift(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
  ) {
    await this.shiftsService.deleteShift(organizationId, shiftId);
  }

  // ============ Registrations ============

  @Get(':planId/registrations')
  async findAllRegistrations(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const registrations = await this.shiftsService.findAllRegistrations(organizationId, planId);
    return { data: registrations };
  }

  @Post('registrations/:registrationId/approve')
  async approveRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() dto: ApproveRegistrationDto,
    @CurrentUser() user: User,
  ) {
    const registration = await this.shiftsService.approveRegistration(
      organizationId,
      registrationId,
      user,
      dto.message,
    );
    return { data: registration };
  }

  @Post('registrations/:registrationId/reject')
  async rejectRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() dto: RejectRegistrationDto,
    @CurrentUser() user: User,
  ) {
    const registration = await this.shiftsService.rejectRegistration(
      organizationId,
      registrationId,
      user,
      dto.reason,
    );
    return { data: registration };
  }

  @Post('registrations/:registrationId/message')
  @HttpCode(HttpStatus.NO_CONTENT)
  async sendMessage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: User,
  ) {
    await this.shiftsService.sendMessage(organizationId, registrationId, user, dto.message);
  }

  @Delete('registrations/:registrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    await this.shiftsService.deleteRegistration(organizationId, registrationId);
  }

  @Patch('registrations/:registrationId/notes')
  async updateRegistrationNotes(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() dto: UpdateRegistrationNotesDto,
  ) {
    const registration = await this.shiftsService.updateRegistrationNotes(
      organizationId,
      registrationId,
      dto.adminNotes || '',
    );
    return { data: registration };
  }
}
