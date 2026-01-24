import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import {
  Organization,
  User,
  UserOrganization,
  Invitation,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
  AddMemberDto,
  UpdateMemberDto,
  CreateInvitationDto,
} from './dto';

const INVITATION_EXPIRY_DAYS = 7;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    createDto: CreateOrganizationDto,
    user: User,
  ): Promise<Organization> {
    const slug = await this.generateSlug(createDto.name);
    const supportPin = this.generateSupportPin();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const organization = this.organizationRepository.create({
        name: createDto.name,
        slug,
        supportPin,
        settings: createDto.settings || {},
      });
      await queryRunner.manager.save(organization);

      // Add creator as admin
      const userOrganization = this.userOrganizationRepository.create({
        user,
        organization,
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
        permissions: {},
      });
      await queryRunner.manager.save(userOrganization);

      await queryRunner.commitTransaction();

      this.logger.log(`Organization created: ${organization.name} (${organization.id})`);

      return organization;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Organization>> {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    // Get organizations where user is a member
    const query = this.organizationRepository
      .createQueryBuilder('org')
      .innerJoin('org.userOrganizations', 'uo', 'uo.userId = :userId', { userId: user.id })
      .where('org.deletedAt IS NULL')
      .orderBy('org.name', 'ASC')
      .skip(skip)
      .take(limit);

    const [items, total] = await query.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(id: string, user: User): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id },
      relations: ['userOrganizations', 'userOrganizations.user'],
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    // Check if user is a member
    await this.checkMembership(organization.id, user.id);

    return organization;
  }

  async update(
    id: string,
    updateDto: UpdateOrganizationDto,
    user: User,
  ): Promise<Organization> {
    const organization = await this.findOne(id, user);

    // Check if user is admin
    await this.checkRole(organization.id, user.id, OrganizationRole.ADMIN);

    Object.assign(organization, updateDto);
    await this.organizationRepository.save(organization);

    this.logger.log(`Organization updated: ${organization.name} (${organization.id})`);

    return organization;
  }

  async remove(id: string, user: User): Promise<void> {
    const organization = await this.findOne(id, user);

    // Check if user is admin
    await this.checkRole(organization.id, user.id, OrganizationRole.ADMIN);

    // Soft delete
    await this.organizationRepository.softRemove(organization);

    this.logger.log(`Organization deleted: ${organization.name} (${organization.id})`);
  }

  // Member Management
  async getMembers(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<UserOrganization>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.userOrganizationRepository.findAndCount({
      where: { organizationId },
      relations: ['user'],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async addMember(
    organizationId: string,
    addMemberDto: AddMemberDto,
    currentUser: User,
  ): Promise<UserOrganization> {
    // Check if current user is admin/manager
    await this.checkRole(organizationId, currentUser.id, OrganizationRole.MANAGER);

    // Find user by email
    const user = await this.userRepository.findOne({
      where: { email: addMemberDto.email.toLowerCase() },
    });

    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    // Check if already a member
    const existingMember = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: user.id },
    });

    if (existingMember) {
      throw new ConflictException({
        code: ErrorCodes.MEMBER_ALREADY_EXISTS,
        message: 'Benutzer ist bereits Mitglied',
      });
    }

    const userOrganization = this.userOrganizationRepository.create({
      organizationId,
      userId: user.id,
      role: addMemberDto.role,
      permissions: addMemberDto.permissions || {},
    });

    await this.userOrganizationRepository.save(userOrganization);

    this.logger.log(`Member added to organization ${organizationId}: ${user.email}`);

    return this.userOrganizationRepository.findOneOrFail({
      where: { id: userOrganization.id },
      relations: ['user'],
    });
  }

  async updateMember(
    organizationId: string,
    memberId: string,
    updateDto: UpdateMemberDto,
    currentUser: User,
  ): Promise<UserOrganization> {
    // Check if current user is admin/manager
    await this.checkRole(organizationId, currentUser.id, OrganizationRole.MANAGER);

    const member = await this.userOrganizationRepository.findOne({
      where: { id: memberId, organizationId },
      relations: ['user'],
    });

    if (!member) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Mitglied nicht gefunden',
      });
    }

    // Prevent self-demotion from admin
    if (member.userId === currentUser.id && updateDto.role && updateDto.role !== OrganizationRole.ADMIN) {
      const adminCount = await this.userOrganizationRepository.count({
        where: { organizationId, role: OrganizationRole.ADMIN },
      });

      if (adminCount <= 1) {
        throw new BadRequestException({
          code: ErrorCodes.FORBIDDEN,
          message: 'Mindestens ein Admin muss bestehen bleiben',
        });
      }
    }

    Object.assign(member, updateDto);
    await this.userOrganizationRepository.save(member);

    this.logger.log(`Member updated in organization ${organizationId}: ${member.user.email}`);

    return member;
  }

  async removeMember(
    organizationId: string,
    memberId: string,
    currentUser: User,
  ): Promise<void> {
    // Check if current user is admin/manager
    await this.checkRole(organizationId, currentUser.id, OrganizationRole.MANAGER);

    const member = await this.userOrganizationRepository.findOne({
      where: { id: memberId, organizationId },
      relations: ['user'],
    });

    if (!member) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Mitglied nicht gefunden',
      });
    }

    // Prevent removing last admin
    if (member.role === OrganizationRole.ADMIN) {
      const adminCount = await this.userOrganizationRepository.count({
        where: { organizationId, role: OrganizationRole.ADMIN },
      });

      if (adminCount <= 1) {
        throw new BadRequestException({
          code: ErrorCodes.FORBIDDEN,
          message: 'Der letzte Admin kann nicht entfernt werden',
        });
      }
    }

    await this.userOrganizationRepository.remove(member);

    this.logger.log(`Member removed from organization ${organizationId}: ${member.user.email}`);
  }

  // Invitation Management
  async createInvitation(
    organizationId: string,
    createDto: CreateInvitationDto,
    currentUser: User,
  ): Promise<Invitation> {
    // Check if current user is admin/manager
    await this.checkRole(organizationId, currentUser.id, OrganizationRole.MANAGER);

    const organization = await this.organizationRepository.findOneOrFail({
      where: { id: organizationId },
    });

    // Check if user already exists and is a member
    const existingUser = await this.userRepository.findOne({
      where: { email: createDto.email.toLowerCase() },
    });

    if (existingUser) {
      const existingMember = await this.userOrganizationRepository.findOne({
        where: { organizationId, userId: existingUser.id },
      });

      if (existingMember) {
        throw new ConflictException({
          code: ErrorCodes.MEMBER_ALREADY_EXISTS,
          message: 'Benutzer ist bereits Mitglied',
        });
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await this.invitationRepository.findOne({
      where: {
        organizationId,
        email: createDto.email.toLowerCase(),
        acceptedAt: undefined,
      },
    });

    if (existingInvitation && existingInvitation.expiresAt > new Date()) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        message: 'Eine Einladung für diese E-Mail existiert bereits',
      });
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invitation = this.invitationRepository.create({
      organization,
      organizationId,
      email: createDto.email.toLowerCase(),
      role: createDto.role,
      token,
      expiresAt,
      invitedByUser: currentUser,
      invitedByUserId: currentUser.id,
    });

    await this.invitationRepository.save(invitation);

    // TODO: Send invitation email
    this.logger.log(`Invitation created for ${createDto.email} to organization ${organizationId}`);
    this.logger.log(`Invitation link: /invitations/${token}/accept`);

    return invitation;
  }

  async getInvitations(
    organizationId: string,
    user: User,
  ): Promise<Invitation[]> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    return this.invitationRepository.find({
      where: { organizationId },
      relations: ['invitedByUser'],
      order: { createdAt: 'DESC' },
    });
  }

  async cancelInvitation(
    organizationId: string,
    invitationId: string,
    user: User,
  ): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, organizationId },
    });

    if (!invitation) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Einladung nicht gefunden',
      });
    }

    await this.invitationRepository.remove(invitation);

    this.logger.log(`Invitation cancelled: ${invitationId}`);
  }

  async getInvitationByToken(token: string): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
      relations: ['organization'],
    });

    if (!invitation) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Einladung nicht gefunden',
      });
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException({
        code: ErrorCodes.INVITATION_EXPIRED,
        message: 'Einladung ist abgelaufen',
      });
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException({
        code: ErrorCodes.CONFLICT,
        message: 'Einladung wurde bereits angenommen',
      });
    }

    return invitation;
  }

  async acceptInvitation(token: string, user: User): Promise<UserOrganization> {
    const invitation = await this.getInvitationByToken(token);

    // Check if email matches
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Diese Einladung ist für eine andere E-Mail-Adresse',
      });
    }

    // Check if already a member
    const existingMember = await this.userOrganizationRepository.findOne({
      where: { organizationId: invitation.organizationId, userId: user.id },
    });

    if (existingMember) {
      throw new ConflictException({
        code: ErrorCodes.MEMBER_ALREADY_EXISTS,
        message: 'Sie sind bereits Mitglied dieser Organisation',
      });
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Create membership
      const userOrganization = this.userOrganizationRepository.create({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        permissions: {},
      });
      await queryRunner.manager.save(userOrganization);

      // Mark invitation as accepted
      invitation.acceptedAt = new Date();
      await queryRunner.manager.save(invitation);

      await queryRunner.commitTransaction();

      this.logger.log(`Invitation accepted: ${user.email} joined organization ${invitation.organizationId}`);

      return this.userOrganizationRepository.findOneOrFail({
        where: { id: userOrganization.id },
        relations: ['organization'],
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async declineInvitation(token: string, user: User): Promise<void> {
    const invitation = await this.getInvitationByToken(token);

    // Check if email matches
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Diese Einladung ist für eine andere E-Mail-Adresse',
      });
    }

    // Delete the invitation
    await this.invitationRepository.remove(invitation);

    this.logger.log(`Invitation declined: ${user.email} declined invitation to organization ${invitation.organizationId}`);
  }

  // Helper methods
  private async checkMembership(organizationId: string, userId: string): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    return membership;
  }

  private async checkRole(
    organizationId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, userId);

    const roleHierarchy: Record<OrganizationRole, number> = {
      [OrganizationRole.ADMIN]: 100,
      [OrganizationRole.MANAGER]: 80,
      [OrganizationRole.CASHIER]: 40,
      [OrganizationRole.KITCHEN]: 20,
      [OrganizationRole.DELIVERY]: 20,
    };

    if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }

  async verifyMemberAccess(
    organizationId: string,
    user: User,
    allowedRoles: string[],
  ): Promise<UserOrganization> {
    // Super admins always have access
    if (user.isSuperAdmin) {
      return { role: OrganizationRole.ADMIN } as UserOrganization;
    }

    const membership = await this.checkMembership(organizationId, user.id);

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen für diese Aktion',
      });
    }

    return membership;
  }

  private async generateSlug(name: string): Promise<string> {
    const baseSlug = name
      .toLowerCase()
      .replace(/[äöü]/g, (match) => {
        const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue' };
        return map[match];
      })
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    let slug = baseSlug;
    let counter = 1;

    while (await this.organizationRepository.findOne({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private generateSupportPin(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
