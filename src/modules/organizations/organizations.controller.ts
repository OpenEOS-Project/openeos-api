import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  StreamableFile,
  Optional,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { GatewayService } from '../gateway/gateway.service';
import { DevicesService } from '../devices/devices.service';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
  AddMemberDto,
  UpdateMemberDto,
  CreateInvitationDto,
  BroadcastMessageDto,
  UpdateIntegrationDto,
  SetOperatingModeDto,
  SetOrganizationCountryDto,
} from './dto';
import { SetPinDto } from '../devices/dto';
import { CurrentUser, Public, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';
import { OperatingModeService } from './operating-mode/operating-mode.service';
import { CountryService } from './country/country.service';
import { OrganizationViewService } from './organization-view.service';
import { ClosedOrganizationAccess } from '../../common/organization-closure/organization-closure.guard';
import {
  TARGET_LIMITS,
  TargetLimitService,
} from '../../common/rate-limit/target-limit.service';

@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly gatewayService: GatewayService,
    private readonly devicesService: DevicesService,
    private readonly operatingModeService: OperatingModeService,
    private readonly countryService: CountryService,
    private readonly organizationView: OrganizationViewService,
    @Optional() private readonly targetLimits?: TargetLimitService,
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateOrganizationDto,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.create(
      createDto,
      user,
    );
    return { data: await this.organizationView.view(organization) };
  }

  @Get()
  async findAll(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    const page = await this.organizationsService.findAll(user, pagination);
    return { ...page, data: await this.organizationView.views(page.data) };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':id')
  @ApiOperation({
    operationId: 'getOrganization',
    summary: 'Organisation abrufen',
    description:
      'Liefert Stammdaten, Einstellungen und freigeschaltete Module der Organisation. Scope `read`; ein Token sieht nur seine eigene Organisation.',
  })
  @ApiParam({ name: 'id', description: 'ID der Organisation', format: 'uuid' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.findOne(id, user);
    const usage = await this.organizationsService.memberUsage(organization);
    // Abgeleitete Felder (Betriebsart, tseActive, cashAllowed,
    // pricesVisible, tse) wie jede Organisations-Antwort, dazu die Plaetze.
    return {
      data: { ...(await this.organizationView.view(organization)), ...usage },
    };
  }

  @ApiTokenAccess(TokenScope.SETTINGS_WRITE)
  @Patch(':id')
  @ApiOperation({
    operationId: 'updateOrganization',
    summary: 'Organisation ändern',
    description:
      'Ändert Name, Kontaktdaten oder Einstellungen. Die Betriebsart und das Land ändern sich nur über ihre eigenen Endpunkte. Scope `settings:write`, nur für Administratoren; geänderte Einstellungen gehen sofort an die Kassen.',
  })
  @ApiParam({ name: 'id', description: 'ID der Organisation', format: 'uuid' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateOrganizationDto,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.update(
      id,
      updateDto,
      user,
    );
    // Kassen sofort umstellen, nicht erst beim naechsten Neuladen.
    if (updateDto.settings) {
      this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    }
    return { data: await this.organizationView.view(organization) };
  }

  // PATCH wie alle anderen Aenderungen: die CORS-Konfiguration kennt kein PUT,
  // und ein Browser-Aufruf scheiterte schon an der Vorabfrage.
  @Patch(':id/integrations/:integrationId')
  @ApiOperation({
    summary: 'Enable or disable an integration (admins only)',
    description:
      'Integrationen: `sumup`, `tse` (Cloud-TSE, nur Deutschland; Ausschalten mit aktiver TSE: 409 TSE_ACTIVE_DEACTIVATE_FIRST — erst ausdrücklich deaktivieren).',
  })
  async setIntegration(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('integrationId') integrationId: string,
    @Body() updateDto: UpdateIntegrationDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const organization = await this.organizationsService.setIntegrationEnabled(
      id,
      integrationId,
      updateDto.enabled,
      user,
      {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    return { data: await this.organizationView.view(organization) };
  }

  @Get(':id/operating-mode')
  @ApiOperation({
    summary: 'Operating mode with options and change log',
    description:
      'Betriebsart (`orders_only` „Nur Bons“, `cashless` „Bargeldlos“, `full` „Alle Funktionen“), Bestand (`operatingModeLegacy`), Land, TSE, abgeleitete Werte (`cashAllowed`, `pricesVisible`), wählbare Betriebsarten (`options`, Gründe `unavailableReason`: `country_required`, `tse_required`, `tse_coming_soon` = Cloud-TSE bald verfügbar, `paid_event_required`) und Verlauf.',
  })
  async getOperatingMode(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.operatingModeService.getForMember(id, user) };
  }

  @Patch(':id/operating-mode')
  @ApiOperation({
    summary: 'Switch the operating mode (admins, logged)',
    description:
      'Wechselt die Betriebsart. `full` geht in Deutschland nur mit aktiver Cloud-TSE (sonst 403 TSE_REQUIRED_FOR_CASH); ohne Land 400 COUNTRY_REQUIRED. Jeder Wechsel hebt den Bestand auf, steht im Verlauf und im Protokoll und geht sofort an die Kassen.',
  })
  async setOperatingMode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOperatingModeDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    await this.operatingModeService.setByMember(id, dto.operatingMode, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return { data: await this.operatingModeService.getForMember(id, user) };
  }

  // Nur gehostet: in einer eigenen Installation ist der Verein selbst
  // Betreiber und Hersteller-Angaben passen nicht.
  @SaasOnly()
  @Get(':id/operating-mode/certificate.pdf')
  @ApiOperation({
    summary: 'Manufacturer certificate for the operating mode (PDF, admins)',
    description:
      'Herstellerbescheinigung für die Verfahrensdokumentation: Bargeld kann in dieser Organisation nicht erfasst werden; Bargeld ist ausschließlich mit aktiver zertifizierter TSE möglich. Nur in Deutschland in den Betriebsarten `orders_only` und `cashless`.',
  })
  async getOperatingModeCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.operatingModeService.certificatePdf(
      id,
      user,
    );
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    });
    return new StreamableFile(pdf);
  }

  @Patch(':id/country')
  @ApiOperation({
    summary: 'Set the country once (admins, only while none is set)',
    description:
      'Für Bestandsorganisationen ohne Land: einmalig setzen. Steht schon ein Land, 403 COUNTRY_ALREADY_SET — ändern kann es dann nur der OpenEOS-Support.',
  })
  async setCountry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrganizationCountryDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    await this.countryService.setCountryOnce(id, dto.country, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return { data: await this.operatingModeService.getForMember(id, user) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    await this.organizationsService.remove(id, user);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ClosedOrganizationAccess()
  @ApiOperation({
    summary:
      'Cancel the deletion of an organization (admins, until the final deletion)',
  })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.restore(id, user);
    return { data: await this.organizationView.view(organization) };
  }

  // Member Management
  @Get(':id/members')
  async getMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.organizationsService.getMembers(id, user, pagination);
  }

  @Post(':id/members')
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() addMemberDto: AddMemberDto,
    @CurrentUser() user: User,
  ) {
    const member = await this.organizationsService.addMember(
      id,
      addMemberDto,
      user,
    );
    return { data: member };
  }

  @Patch(':id/members/:memberId')
  async updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() updateDto: UpdateMemberDto,
    @CurrentUser() user: User,
  ) {
    const member = await this.organizationsService.updateMember(
      id,
      memberId,
      updateDto,
      user,
    );
    return { data: member };
  }

  @Delete(':id/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @CurrentUser() user: User,
  ) {
    await this.organizationsService.removeMember(id, memberId, user);
  }

  // PIN Management
  @Post(':id/members/:userId/pin')
  @HttpCode(HttpStatus.OK)
  async setMemberPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() setPinDto: SetPinDto,
    @CurrentUser() user: User,
  ) {
    await this.devicesService.setMemberPin(id, userId, setPinDto.pin, user);
    return { message: 'PIN gesetzt' };
  }

  @Delete(':id/members/:userId/pin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMemberPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: User,
  ) {
    await this.devicesService.removeMemberPin(id, userId, user);
  }

  // Invitation Management
  @Get(':id/invitations')
  async getInvitations(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const invitations = await this.organizationsService.getInvitations(
      id,
      user,
    );
    return { data: invitations };
  }

  @Post(':id/invitations')
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  async createInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() createDto: CreateInvitationDto,
    @CurrentUser() user: User,
  ) {
    await this.targetLimits?.assert(
      'invitation',
      createDto.email,
      TARGET_LIMITS.invitation,
      'An diese Adresse wurden heute schon mehrere Einladungen geschickt.',
    );
    const invitation = await this.organizationsService.createInvitation(
      id,
      createDto,
      user,
    );
    return { data: invitation };
  }

  @Post(':id/invitations/:invitationId/resend')
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  async resendInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: User,
  ) {
    await this.targetLimits?.assert(
      'invitation-resend',
      invitationId,
      TARGET_LIMITS.invitationResend,
      'Diese Einladung wurde gerade erst verschickt. Bitte versuche es später noch einmal.',
    );
    await this.organizationsService.resendInvitation(id, invitationId, user);
    return { message: 'Einladung erneut gesendet' };
  }

  @Delete(':id/invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: User,
  ) {
    await this.organizationsService.cancelInvitation(id, invitationId, user);
  }

  // Broadcast Messages
  @Post(':id/broadcast')
  @ApiOperation({
    summary: 'Broadcast message to all devices',
    description: 'Send a message to all connected devices in the organization',
  })
  @ApiResponse({ status: 201, description: 'Message broadcasted' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - not a member or insufficient permissions',
  })
  async broadcastMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() broadcastDto: BroadcastMessageDto,
    @CurrentUser() user: User,
  ) {
    // Verify user has access to this organization (admin or manager)
    await this.organizationsService.verifyMemberAccess(id, user, [
      'admin',
      'manager',
    ]);

    const broadcast = this.gatewayService.broadcastMessage(id, {
      message: broadcastDto.message,
      type: broadcastDto.type,
      title: broadcastDto.title,
      duration: broadcastDto.duration,
      senderId: user.id,
      senderName: `${user.firstName} ${user.lastName}`,
    });

    return { data: broadcast };
  }
}

// Separate controller for public invitation endpoints
@ApiTags('Organizations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Public()
  @Get(':token')
  async getInvitation(@Param('token') token: string) {
    const invitation =
      await this.organizationsService.getInvitationByToken(token);
    return {
      data: {
        email: invitation.email,
        organizationName: invitation.organization.name,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    };
  }

  @Post(':token/accept')
  async acceptInvitation(
    @Param('token') token: string,
    @CurrentUser() user: User,
  ) {
    const membership = await this.organizationsService.acceptInvitation(
      token,
      user,
    );
    return { data: membership };
  }

  @Post(':token/decline')
  async declineInvitation(
    @Param('token') token: string,
    @CurrentUser() user: User,
  ) {
    await this.organizationsService.declineInvitation(token, user);
    return { message: 'Einladung abgelehnt' };
  }
}
