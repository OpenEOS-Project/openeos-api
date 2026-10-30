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
  Headers,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
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
  BroadcastMessageDto,
  UpdateRegistrationNotesDto,
  AdminCreateRegistrationDto,
  AdminUpdateRegistrationDto,
} from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { OrganizationGuard } from '../../common/guards/organization.guard';

@ApiTags('Shift Plans')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiExtraModels(CreateShiftDto)
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/shift-plans')
@UseGuards(OrganizationGuard)
export class ShiftsController {
  constructor(
    private readonly shiftsService: ShiftsService,
    private readonly pdfService: ShiftPdfService,
  ) {}

  // ============ Shift Plans ============

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createShiftPlan',
    summary: 'Schichtplan anlegen',
    description:
      'Legt einen Schichtplan als Entwurf an. Scope `staff:write` und Modulrecht Schichtpläne.',
  })
  async createPlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateShiftPlanDto,
  ) {
    const plan = await this.shiftsService.createPlan(organizationId, dto);
    return { data: plan };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listShiftPlans',
    summary: 'Schichtpläne auflisten',
    description:
      'Alle Schichtpläne der Organisation mit Status (Entwurf, veröffentlicht, geschlossen). Scope `read`.',
  })
  async findAllPlans(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    const plans = await this.shiftsService.findAllPlans(organizationId);
    return { data: plans };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':planId')
  @ApiOperation({
    operationId: 'getShiftPlan',
    summary: 'Schichtplan abrufen',
    description: 'Ein Schichtplan mit seinen Jobs und Schichten. Scope `read`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async findOnePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.findOnePlan(organizationId, planId);
    return { data: plan };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Patch(':planId')
  @ApiOperation({
    operationId: 'updateShiftPlan',
    summary: 'Schichtplan ändern',
    description:
      'Ändert Name, Zeitraum, Beschreibung oder Einstellungen eines Schichtplans. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async updatePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdateShiftPlanDto,
  ) {
    const plan = await this.shiftsService.updatePlan(
      organizationId,
      planId,
      dto,
    );
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

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post(':planId/publish')
  @ApiOperation({
    operationId: 'publishShiftPlan',
    summary: 'Schichtplan veröffentlichen',
    description:
      'Schaltet den Plan für die öffentliche Helfer-Anmeldung frei (`400 SHIFT_PLAN_ALREADY_PUBLISHED`, wenn er schon offen ist). Scope `staff:write`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async publishPlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.publishPlan(organizationId, planId);
    return { data: plan };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post(':planId/close')
  @ApiOperation({
    operationId: 'closeShiftPlan',
    summary: 'Schichtplan schließen',
    description:
      'Beendet die Anmeldung; bestehende Anmeldungen bleiben erhalten. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async closePlan(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const plan = await this.shiftsService.closePlan(organizationId, planId);
    return { data: plan };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':planId/export/pdf')
  @ApiOperation({
    operationId: 'exportShiftPlanPdf',
    summary: 'Schichtplan als PDF exportieren',
    description:
      'Liefert den Plan mit allen Jobs, Schichten und eingetragenen Helfern als Datei (`application/pdf`). Scope `read`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
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

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post(':planId/jobs')
  @ApiOperation({
    operationId: 'createShiftJob',
    summary: 'Job anlegen',
    description:
      'Legt eine Aufgabe (z. B. Ausschank, Kasse) im Schichtplan an. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async createJob(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreateShiftJobDto,
  ) {
    const job = await this.shiftsService.createJob(organizationId, planId, dto);
    return { data: job };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':planId/jobs')
  @ApiOperation({
    operationId: 'listShiftJobs',
    summary: 'Jobs auflisten (je Schichtplan)',
    description:
      'Alle Jobs eines Schichtplans mit ihren Schichten. Scope `read`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async findAllJobs(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const jobs = await this.shiftsService.findAllJobs(organizationId, planId);
    return { data: jobs };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Patch('jobs/:jobId')
  @ApiOperation({
    operationId: 'updateShiftJob',
    summary: 'Job ändern',
    description:
      'Ändert Name, Beschreibung oder Reihenfolge eines Jobs. Scope `staff:write`.',
  })
  @ApiParam({ name: 'jobId', description: 'ID des Jobs', format: 'uuid' })
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

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post('jobs/:jobId/shifts')
  @ApiOperation({
    operationId: 'createShift',
    summary: 'Schicht anlegen',
    description:
      'Legt eine Schicht (Zeitraum, benötigte Helfer) für einen Job an. Scope `staff:write`.',
  })
  @ApiParam({ name: 'jobId', description: 'ID des Jobs', format: 'uuid' })
  async createShift(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: CreateShiftDto,
  ) {
    const shift = await this.shiftsService.createShift(
      organizationId,
      jobId,
      dto,
    );
    return { data: shift };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post('jobs/:jobId/shifts/bulk')
  @ApiOperation({
    operationId: 'createShiftsBulk',
    summary: 'Mehrere Schichten anlegen',
    description:
      'Legt mehrere Schichten für einen Job in einem Aufruf an. Scope `staff:write`.',
  })
  @ApiParam({ name: 'jobId', description: 'ID des Jobs', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['shifts'],
      properties: {
        shifts: {
          type: 'array',
          description: 'Schichten, die angelegt werden',
          items: { $ref: getSchemaPath(CreateShiftDto) },
        },
      },
    },
  })
  async createShiftsBulk(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: { shifts: CreateShiftDto[] },
  ) {
    const shifts = await this.shiftsService.createShiftsBulk(
      organizationId,
      jobId,
      dto.shifts,
    );
    return { data: shifts };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('jobs/:jobId/shifts')
  @ApiOperation({
    operationId: 'listShifts',
    summary: 'Schichten auflisten (je Job)',
    description: 'Alle Schichten eines Jobs mit Belegung. Scope `read`.',
  })
  @ApiParam({ name: 'jobId', description: 'ID des Jobs', format: 'uuid' })
  async findAllShifts(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    const shifts = await this.shiftsService.findAllShifts(
      organizationId,
      jobId,
    );
    return { data: shifts };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Patch('shifts/:shiftId')
  @ApiOperation({
    operationId: 'updateShift',
    summary: 'Schicht ändern',
    description:
      'Ändert Zeitraum, benötigte Helfer oder Notiz einer Schicht. Scope `staff:write`.',
  })
  @ApiParam({ name: 'shiftId', description: 'ID der Schicht', format: 'uuid' })
  async updateShift(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: UpdateShiftDto,
  ) {
    const shift = await this.shiftsService.updateShift(
      organizationId,
      shiftId,
      dto,
    );
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

  @ApiTokenAccess(TokenScope.READ)
  @Get(':planId/registrations')
  @ApiOperation({
    operationId: 'listShiftRegistrations',
    summary: 'Helfer-Anmeldungen auflisten (je Schichtplan)',
    description:
      'Alle Anmeldungen eines Schichtplans mit Status und Schicht. Scope `read`.',
  })
  @ApiParam({
    name: 'planId',
    description: 'ID des Schichtplans',
    format: 'uuid',
  })
  async findAllRegistrations(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const registrations = await this.shiftsService.findAllRegistrations(
      organizationId,
      planId,
    );
    return { data: registrations };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post('registrations/:registrationId/approve')
  @ApiOperation({
    operationId: 'approveShiftRegistration',
    summary: 'Anmeldung annehmen',
    description:
      'Bestätigt eine Helfer-Anmeldung; der Helfer bekommt eine E-Mail, optional mit Nachricht. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'registrationId',
    description: 'ID der Anmeldung',
    format: 'uuid',
  })
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

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post('registrations/:registrationId/reject')
  @ApiOperation({
    operationId: 'rejectShiftRegistration',
    summary: 'Anmeldung ablehnen',
    description:
      'Lehnt eine Helfer-Anmeldung ab; der Grund geht per E-Mail an den Helfer. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'registrationId',
    description: 'ID der Anmeldung',
    format: 'uuid',
  })
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
    await this.shiftsService.sendMessage(
      organizationId,
      registrationId,
      user,
      dto.message,
    );
  }

  @Post(':planId/broadcast')
  @HttpCode(HttpStatus.OK)
  async broadcastMessage(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: BroadcastMessageDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.shiftsService.broadcastMessage(
      organizationId,
      planId,
      user,
      dto.message,
      dto.recipientEmails,
      dto.subject,
    );
    return { data: result };
  }

  @Delete('registrations/:registrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    await this.shiftsService.deleteRegistration(organizationId, registrationId);
  }

  @Delete('registrations/:registrationId/one')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSingleRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    await this.shiftsService.removeSingleRegistration(
      organizationId,
      registrationId,
    );
  }

  @Post('registrations/:registrationId/mark-verified')
  async markRegistrationVerified(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
  ) {
    const registration = await this.shiftsService.markRegistrationVerified(
      organizationId,
      registrationId,
    );
    return { data: registration };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Patch('registrations/:registrationId/notes')
  @ApiOperation({
    operationId: 'updateShiftRegistrationNotes',
    summary: 'Interne Notiz zur Anmeldung setzen',
    description:
      'Speichert eine Notiz, die nur Organisatoren sehen. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'registrationId',
    description: 'ID der Anmeldung',
    format: 'uuid',
  })
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

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Post('shifts/:shiftId/registrations')
  @ApiOperation({
    operationId: 'createShiftRegistration',
    summary: 'Helfer in Schicht eintragen',
    description:
      'Trägt einen Helfer direkt in eine Schicht ein, ohne öffentliche Anmeldung. Scope `staff:write`.',
  })
  @ApiParam({ name: 'shiftId', description: 'ID der Schicht', format: 'uuid' })
  async adminCreateRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Body() dto: AdminCreateRegistrationDto,
  ) {
    const registration = await this.shiftsService.adminCreateRegistration(
      organizationId,
      shiftId,
      dto,
    );
    return { data: registration };
  }

  @ApiTokenAccess(TokenScope.STAFF_WRITE)
  @Patch('registrations/:registrationId')
  @ApiOperation({
    operationId: 'updateShiftRegistration',
    summary: 'Anmeldung ändern',
    description:
      'Ändert Name, Kontakt, Notizen oder Schicht einer Anmeldung; auf Wunsch wird der Helfer per E-Mail informiert. Scope `staff:write`.',
  })
  @ApiParam({
    name: 'registrationId',
    description: 'ID der Anmeldung',
    format: 'uuid',
  })
  async adminUpdateRegistration(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() dto: AdminUpdateRegistrationDto,
  ) {
    const registration = await this.shiftsService.adminUpdateRegistration(
      organizationId,
      registrationId,
      dto,
    );
    return { data: registration };
  }

  /** Multi-op proposal: admin stages add/remove operations against a helper's
   *  group, the helper accepts or declines via the email link. */
  @Post('registration-groups/:registrationGroupId/propose')
  async proposeRegistrationChanges(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('registrationGroupId', ParseUUIDPipe) registrationGroupId: string,
    @Body()
    body: {
      ops: Array<
        | { type: 'add'; shiftId: string }
        | { type: 'remove'; registrationId: string }
      >;
      message?: string;
    },
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    let baseUrl = origin;
    if (!baseUrl && referer) {
      try {
        baseUrl = new URL(referer).origin;
      } catch {
        /* noop */
      }
    }
    const proposal = await this.shiftsService.proposeRegistrationChanges(
      organizationId,
      registrationGroupId,
      body.ops,
      body.message,
      baseUrl,
    );
    return { data: proposal };
  }
}
