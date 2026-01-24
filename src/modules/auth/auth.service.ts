import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import {
  User,
  Organization,
  UserOrganization,
  RefreshToken,
  Invitation,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import {
  RegisterDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto';
import { JwtPayload } from './strategies/jwt.strategy';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;
const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const PASSWORD_RESET_EXPIRY_HOURS = 1;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  async getPendingInvitations(userId: string): Promise<Invitation[]> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    return this.invitationRepository.find({
      where: {
        email: user.email.toLowerCase(),
        acceptedAt: IsNull(),
      },
      relations: ['organization'],
      order: { createdAt: 'DESC' },
    });
  }

  async register(registerDto: RegisterDto): Promise<{
    user: User;
    accessToken: string;
    refreshToken: string;
  }> {
    const { email, password, firstName, lastName, organizationName } = registerDto;

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException({
        code: ErrorCodes.USER_EXISTS,
        message: 'Ein Benutzer mit dieser E-Mail-Adresse existiert bereits',
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Use transaction for user and organization creation
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Create user
      const user = this.userRepository.create({
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        isActive: true,
      });
      await queryRunner.manager.save(user);

      // Create organization if name provided
      if (organizationName) {
        const slug = await this.generateOrganizationSlug(organizationName);
        const supportPin = this.generateSupportPin();

        const organization = this.organizationRepository.create({
          name: organizationName,
          slug,
          supportPin,
          settings: {},
        });
        await queryRunner.manager.save(organization);

        // Create user-organization relationship as admin
        const userOrganization = this.userOrganizationRepository.create({
          user,
          organization,
          role: OrganizationRole.ADMIN,
        });
        await queryRunner.manager.save(userOrganization);
      }

      await queryRunner.commitTransaction();

      // Generate tokens
      const tokens = await this.generateTokens(user);

      this.logger.log(`User registered: ${user.email}`);

      return {
        user,
        ...tokens,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      return null;
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMinutes = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_LOCKED,
        message: `Konto ist für ${remainingMinutes} Minuten gesperrt`,
      });
    }

    // Check if account is active
    if (!user.isActive) {
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Konto ist deaktiviert',
      });
    }

    // Validate password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      await this.handleFailedLogin(user);
      return null;
    }

    // Reset failed login attempts on successful login
    if (user.failedLoginAttempts > 0) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      await this.userRepository.save(user);
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    return user;
  }

  private async handleFailedLogin(user: User): Promise<void> {
    user.failedLoginAttempts += 1;

    if (user.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      user.lockedUntil = new Date(
        Date.now() + LOCK_DURATION_MINUTES * 60 * 1000,
      );
      this.logger.warn(`Account locked for user: ${user.email}`);
    }

    await this.userRepository.save(user);
  }

  async login(user: User): Promise<{
    user: User;
    accessToken: string;
    refreshToken: string;
  }> {
    const tokens = await this.generateTokens(user);

    this.logger.log(`User logged in: ${user.email}`);

    return {
      user,
      ...tokens,
    };
  }

  async refreshTokens(refreshTokenValue: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    // Hash the token to find it in the database
    const tokenHash = this.hashToken(refreshTokenValue);

    // Find the refresh token
    const storedToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash },
      relations: ['user'],
    });

    if (!storedToken) {
      throw new UnauthorizedException({
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Ungültiger Refresh-Token',
      });
    }

    // Check if token is expired
    if (storedToken.expiresAt < new Date()) {
      await this.refreshTokenRepository.remove(storedToken);
      throw new UnauthorizedException({
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Refresh-Token ist abgelaufen',
      });
    }

    // Check if token is revoked
    if (storedToken.revokedAt) {
      throw new UnauthorizedException({
        code: ErrorCodes.TOKEN_REVOKED,
        message: 'Refresh-Token wurde widerrufen',
      });
    }

    // Check if user is still active
    if (!storedToken.user.isActive) {
      throw new UnauthorizedException({
        code: ErrorCodes.ACCOUNT_INACTIVE,
        message: 'Konto ist deaktiviert',
      });
    }

    // Revoke old token (rotation)
    storedToken.revokedAt = new Date();
    await this.refreshTokenRepository.save(storedToken);

    // Generate new tokens
    const tokens = await this.generateTokens(storedToken.user);

    this.logger.log(`Tokens refreshed for user: ${storedToken.user.email}`);

    return tokens;
  }

  async logout(userId: string, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      // Hash the token to find it
      const tokenHash = this.hashToken(refreshToken);

      // Revoke specific refresh token
      await this.refreshTokenRepository.update(
        { tokenHash, userId },
        { revokedAt: new Date() },
      );
    } else {
      // Revoke all refresh tokens for user
      await this.refreshTokenRepository
        .createQueryBuilder()
        .update()
        .set({ revokedAt: new Date() })
        .where('userId = :userId AND revokedAt IS NULL', { userId })
        .execute();
    }

    // Add access token to blacklist (using Redis cache)
    // The blacklist entry will expire when the token expires
    const accessTokenExpiry = this.configService.get<string>('jwt.expiresIn') || '30m';
    const ttlSeconds = this.parseExpiryToSeconds(accessTokenExpiry);
    await this.cacheManager.set(`blacklist:${userId}`, true, ttlSeconds * 1000);

    this.logger.log(`User logged out: ${userId}`);
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<void> {
    const { email } = forgotPasswordDto;

    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      this.logger.log(`Password reset requested for non-existent email: ${email}`);
      return;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    // Store reset token
    user.passwordResetToken = resetTokenHash;
    user.passwordResetExpiresAt = new Date(
      Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000,
    );
    await this.userRepository.save(user);

    // TODO: Send email with reset link
    // For now, log the token (mock email service)
    this.logger.log(`Password reset token for ${email}: ${resetToken}`);
    this.logger.log(
      `Reset link: ${this.configService.get('frontendUrl')}/auth/reset-password?token=${resetToken}`,
    );
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto): Promise<void> {
    const { token, password } = resetPasswordDto;

    // Hash the provided token to compare with stored hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await this.userRepository.findOne({
      where: { passwordResetToken: tokenHash },
    });

    if (!user) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Ungültiger oder abgelaufener Reset-Token',
      });
    }

    if (
      !user.passwordResetExpiresAt ||
      user.passwordResetExpiresAt < new Date()
    ) {
      throw new BadRequestException({
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Reset-Token ist abgelaufen',
      });
    }

    // Update password
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user.passwordResetToken = null;
    user.passwordResetExpiresAt = null;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.userRepository.save(user);

    // Revoke all refresh tokens
    await this.refreshTokenRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND revokedAt IS NULL', { userId: user.id })
      .execute();

    this.logger.log(`Password reset for user: ${user.email}`);
  }

  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
  ): Promise<void> {
    const { currentPassword, newPassword } = changePasswordDto;

    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Benutzer nicht gefunden',
      });
    }

    // Validate current password
    const isPasswordValid = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Aktuelles Passwort ist falsch',
      });
    }

    // Update password
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.userRepository.save(user);

    this.logger.log(`Password changed for user: ${user.email}`);
  }

  async getCurrentUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Benutzer nicht gefunden',
      });
    }

    return user;
  }

  private async generateTokens(user: User): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      isSuperAdmin: user.isSuperAdmin,
    };

    const accessToken = this.jwtService.sign(payload);

    // Generate refresh token
    const refreshTokenValue = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(refreshTokenValue);
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    const refreshToken = this.refreshTokenRepository.create({
      tokenHash,
      user,
      userId: user.id,
      expiresAt,
    });
    await this.refreshTokenRepository.save(refreshToken);

    return {
      accessToken,
      refreshToken: refreshTokenValue,
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async generateOrganizationSlug(name: string): Promise<string> {
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

    while (
      await this.organizationRepository.findOne({ where: { slug } })
    ) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private generateSupportPin(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) return 1800; // Default 30 minutes

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 24 * 60 * 60;
      default:
        return 1800;
    }
  }
}
