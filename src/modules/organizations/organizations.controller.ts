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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { GatewayService } from '../gateway/gateway.service';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
  AddMemberDto,
  UpdateMemberDto,
  CreateInvitationDto,
  BroadcastMessageDto,
} from './dto';
import { CurrentUser, Public } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly gatewayService: GatewayService,
  ) {}

  @Post()
  async create(
    @Body() createDto: CreateOrganizationDto,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.create(createDto, user);
    return { data: organization };
  }

  @Get()
  async findAll(
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.organizationsService.findAll(user, pagination);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.findOne(id, user);
    return { data: organization };
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateOrganizationDto,
    @CurrentUser() user: User,
  ) {
    const organization = await this.organizationsService.update(id, updateDto, user);
    return { data: organization };
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
    const member = await this.organizationsService.addMember(id, addMemberDto, user);
    return { data: member };
  }

  @Patch(':id/members/:memberId')
  async updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() updateDto: UpdateMemberDto,
    @CurrentUser() user: User,
  ) {
    const member = await this.organizationsService.updateMember(id, memberId, updateDto, user);
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

  // Invitation Management
  @Get(':id/invitations')
  async getInvitations(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const invitations = await this.organizationsService.getInvitations(id, user);
    return { data: invitations };
  }

  @Post(':id/invitations')
  async createInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() createDto: CreateInvitationDto,
    @CurrentUser() user: User,
  ) {
    const invitation = await this.organizationsService.createInvitation(id, createDto, user);
    return { data: invitation };
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
  @ApiOperation({ summary: 'Broadcast message to all devices', description: 'Send a message to all connected devices in the organization' })
  @ApiResponse({ status: 201, description: 'Message broadcasted' })
  @ApiResponse({ status: 403, description: 'Forbidden - not a member or insufficient permissions' })
  async broadcastMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() broadcastDto: BroadcastMessageDto,
    @CurrentUser() user: User,
  ) {
    // Verify user has access to this organization (admin or manager)
    await this.organizationsService.verifyMemberAccess(id, user, ['admin', 'manager']);

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
    const invitation = await this.organizationsService.getInvitationByToken(token);
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
    const membership = await this.organizationsService.acceptInvitation(token, user);
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
