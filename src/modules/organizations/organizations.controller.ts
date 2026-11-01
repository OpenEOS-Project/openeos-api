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
} from '@nestjs/common';
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
  UpdateCashlessDto,
  SetOrganizationCountryDto,
} from './dto';
import { SetPinDto } from '../devices/dto';
import { CurrentUser, Public, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { SaasOnly } from '../../common/decorators/saas-only.decorator';
import {
  getOperatingMode,
  getOperatingModeSince,
} from '../../common/utils/operating-mode.util';
import { OperatingModeService } from './operating-mode/operating-mode.service';
import { CashPolicyService } from './cash-policy/cash-policy.service';
import { cashPolicyView } from '../../common/utils/cash-policy.util';

@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly gatewayService: GatewayService,
    private readonly devicesService: DevicesService,
    private readonly operatingModeService: OperatingModeService,
    private readonly cashPolicyService: CashPolicyService,
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
    return { data: organization };
  }

  @Get()
  async findAll(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.organizationsService.findAll(user, pagination);
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
    return {
      data: {
        ...organization,
        ...usage,
        // Betriebsmodus (nur lesbar; umschalten kann nur der Support)
        operatingMode: getOperatingMode(organization.settings),
        operatingModeSince: getOperatingModeSince(organization.settings),
        // Land und Bargeld-Regel (cash-policy.util.ts): country,
        // cashPolicy, cashPolicyLegacy, cashPolicyReason
        ...cashPolicyView(organization),
      },
    };
  }

  @ApiTokenAccess(TokenScope.SETTINGS_WRITE)
  @Patch(':id')
  @ApiOperation({
    operationId: 'updateOrganization',
    summary: 'Organisation ändern',
    description:
      'Ändert Name, Kontaktdaten oder Einstellungen (z. B. bargeldloser Modus). Scope `settings:write`, nur für Administratoren; geänderte Einstellungen gehen sofort an die Kassen.',
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
    // Kassen sofort umstellen (z. B. bargeldloser Modus), nicht erst beim
    // naechsten Neuladen.
    if (updateDto.settings) {
      this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    }
    return { data: organization };
  }

  // PATCH wie alle anderen Aenderungen: die CORS-Konfiguration kennt kein PUT,
  // und ein Browser-Aufruf scheiterte schon an der Vorabfrage.
  @Patch(':id/integrations/:integrationId')
  @ApiOperation({ summary: 'Enable or disable an integration (admins only)' })
  async setIntegration(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('integrationId') integrationId: string,
    @Body() updateDto: UpdateIntegrationDto,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.setIntegrationEnabled(
      id,
      integrationId,
      updateDto.enabled,
      user,
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    return { data: organization };
  }

  @Patch(':id/payments/cashless')
  @ApiOperation({
    summary: 'Switch cashless mode on or off (admins only, logged)',
    description:
      'Bargeldloser Modus: sperrt jede Barzahlung, Bar-Erstattung, Pfand-Auszahlung und die Kassenlade (403 CASH_PAYMENTS_DISABLED). Jede Umschaltung wird mit Zeitpunkt und Person protokolliert (GET :id/payments/cashless/history).',
  })
  async setCashlessMode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCashlessDto,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const organization = await this.organizationsService.setCashlessMode(
      id,
      dto.cashless,
      user,
      {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    return { data: organization };
  }

  @Get(':id/payments/cashless/history')
  @ApiOperation({ summary: 'Change log of the cashless mode (newest first)' })
  async getCashlessHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.organizationsService.getCashlessHistory(id, user),
    };
  }

  @Get(':id/operating-mode')
  @ApiOperation({
    summary: 'Operating mode with change log (read-only for the organization)',
    description:
      'Betriebsmodus `pos` oder `order_only` („Nur Bestellen“) mit Verlauf. Umschalten kann nur der OpenEOS-Support.',
  })
  async getOperatingMode(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.operatingModeService.getForMember(id, user) };
  }

  @SaasOnly()
  @Get(':id/operating-mode/certificate.pdf')
  @ApiOperation({
    summary: 'Manufacturer certificate for the order-only mode (PDF, admins)',
    description:
      'Herstellerbescheinigung für die Verfahrensdokumentation: das Kassen- und Zahlungsmodul ist deaktiviert und kann von der Organisation nicht selbst aktiviert werden. Nur im Modus `order_only`.',
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

  @Get(':id/cash-policy')
  @ApiOperation({
    summary: 'Country and cash policy with change log',
    description:
      'Land (`country`), wirksame Bargeld-Regel (`cashPolicy`: `allowed` oder `blocked_de_no_tse`), Bestandsschutz (`cashPolicyLegacy`), Kurzgrund (`cashPolicyReason`) und Verlauf.',
  })
  async getCashPolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return { data: await this.cashPolicyService.getForMember(id, user) };
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
    const state = await this.cashPolicyService.setCountryOnce(
      id,
      dto.country,
      user,
      {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(id);
    return { data: state };
  }

  // Nur gehostet: in einer eigenen Installation ist der Verein selbst
  // Betreiber, eine Sperre durch den Hersteller (und der Weg zurueck ueber
  // den Support) gibt es dort nicht.
  @SaasOnly()
  @Post(':id/cash-policy/switch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Leave the legacy cash rules and switch to "Germany without cash" (admins, one-way)',
    description:
      'Nur Bestandsorganisationen mit Land DE. Danach ist Bargeld gesperrt (403 CASH_NOT_ALLOWED_IN_COUNTRY), ohne Schalter für den Verein; zurück nur über den OpenEOS-Support.',
  })
  async switchCashPolicy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Req() request: Request,
  ) {
    const state = await this.cashPolicyService.adoptCountryPolicy(id, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
    });
    // Kassen sofort umstellen (Bargeld weg), nicht erst beim Neuladen.
    this.gatewayService.notifyOrganizationSettingsUpdated(id);
    return { data: state };
  }

  @SaasOnly()
  @Get(':id/cash-policy/certificate.pdf')
  @ApiOperation({
    summary:
      'Manufacturer certificate for "Germany without cash" (PDF, admins)',
    description:
      'Herstellerbescheinigung für die Verfahrensdokumentation: Bargeld kann in OpenEOS nicht erfasst und von der Organisation nicht aktiviert werden; Kartenzahlungen werden erfasst, Bargeld läuft über eine offene Ladenkasse außerhalb. Nur bei `cashPolicy = blocked_de_no_tse`.',
  })
  async getCashPolicyCertificate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { pdf, filename } = await this.cashPolicyService.certificatePdf(
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    await this.organizationsService.remove(id, user);
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
  async createInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() createDto: CreateInvitationDto,
    @CurrentUser() user: User,
  ) {
    const invitation = await this.organizationsService.createInvitation(
      id,
      createDto,
      user,
    );
    return { data: invitation };
  }

  @Post(':id/invitations/:invitationId/resend')
  async resendInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
    @CurrentUser() user: User,
  ) {
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
