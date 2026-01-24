import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, RefreshToken, UserPreferences } from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';
import { UpdateProfileDto, UpdatePreferencesDto, RequestEmailChangeDto } from './dto';

const EMAIL_CHANGE_EXPIRY_HOURS = 24;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Update user profile (name)
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }

    await this.userRepository.save(user);
    this.logger.log(`Profile updated for user: ${user.email}`);

    return user;
  }

  /**
   * Update avatar URL
   */
  async updateAvatar(userId: string, avatarUrl: string): Promise<User> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    user.avatarUrl = avatarUrl;
    await this.userRepository.save(user);
    this.logger.log(`Avatar updated for user: ${user.email}`);

    return user;
  }

  /**
   * Delete avatar
   */
  async deleteAvatar(userId: string): Promise<User> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    user.avatarUrl = null;
    await this.userRepository.save(user);
    this.logger.log(`Avatar deleted for user: ${user.email}`);

    return user;
  }

  /**
   * Request email change
   */
  async requestEmailChange(
    userId: string,
    dto: RequestEmailChangeDto,
  ): Promise<void> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    // Verify current password
    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Passwort ist falsch',
      });
    }

    // Check if new email is already in use
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.newEmail.toLowerCase(), id: Not(userId) },
    });
    if (existingUser) {
      throw new ConflictException({
        code: ErrorCodes.USER_EXISTS,
        message: 'Diese E-Mail-Adresse wird bereits verwendet',
      });
    }

    // Generate verification token
    const token = crypto.randomBytes(32).toString('hex');

    user.pendingEmail = dto.newEmail.toLowerCase();
    user.pendingEmailToken = crypto.createHash('sha256').update(token).digest('hex');
    user.pendingEmailExpiresAt = new Date(
      Date.now() + EMAIL_CHANGE_EXPIRY_HOURS * 60 * 60 * 1000,
    );
    await this.userRepository.save(user);

    // TODO: Send verification email
    this.logger.log(`Email change requested for user: ${user.email} -> ${dto.newEmail}`);
    this.logger.log(`Verification token: ${token}`);
  }

  /**
   * Verify email change
   */
  async verifyEmailChange(token: string): Promise<User> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await this.userRepository.findOne({
      where: { pendingEmailToken: tokenHash },
    });

    if (!user) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_TOKEN,
        message: 'Ungültiger oder abgelaufener Verifizierungslink',
      });
    }

    if (!user.pendingEmailExpiresAt || user.pendingEmailExpiresAt < new Date()) {
      throw new BadRequestException({
        code: ErrorCodes.TOKEN_EXPIRED,
        message: 'Verifizierungslink ist abgelaufen',
      });
    }

    if (!user.pendingEmail) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine ausstehende E-Mail-Änderung',
      });
    }

    // Update email
    const oldEmail = user.email;
    user.email = user.pendingEmail;
    user.pendingEmail = null;
    user.pendingEmailToken = null;
    user.pendingEmailExpiresAt = null;
    await this.userRepository.save(user);

    this.logger.log(`Email changed for user: ${oldEmail} -> ${user.email}`);

    return user;
  }

  /**
   * Get user preferences
   */
  async getPreferences(userId: string): Promise<UserPreferences> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    return user.preferences;
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });

    // Merge preferences
    const currentPreferences = user.preferences || {
      theme: 'system',
      locale: 'de',
      notifications: { email: true, push: true },
    };

    if (dto.theme !== undefined) {
      currentPreferences.theme = dto.theme;
    }
    if (dto.locale !== undefined) {
      currentPreferences.locale = dto.locale;
    }
    if (dto.notifications !== undefined) {
      currentPreferences.notifications = {
        ...currentPreferences.notifications,
        ...dto.notifications,
      };
    }

    user.preferences = currentPreferences;
    await this.userRepository.save(user);

    this.logger.log(`Preferences updated for user: ${user.email}`);

    return user.preferences;
  }

  /**
   * Get active sessions (refresh tokens)
   */
  async getSessions(userId: string): Promise<RefreshToken[]> {
    return this.refreshTokenRepository.find({
      where: { userId, revokedAt: null as unknown as undefined },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Revoke a specific session
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.refreshTokenRepository.update(
      { id: sessionId, userId, revokedAt: null as unknown as undefined },
      { revokedAt: new Date() },
    );

    if (result.affected === 0) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Session nicht gefunden',
      });
    }

    this.logger.log(`Session revoked: ${sessionId}`);
  }

  /**
   * Revoke all other sessions
   */
  async revokeAllOtherSessions(userId: string, currentTokenId?: string): Promise<number> {
    const query = this.refreshTokenRepository
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('userId = :userId AND revokedAt IS NULL', { userId });

    if (currentTokenId) {
      query.andWhere('id != :currentTokenId', { currentTokenId });
    }

    const result = await query.execute();
    this.logger.log(`${result.affected} sessions revoked for user: ${userId}`);

    return result.affected || 0;
  }

  /**
   * Get user by ID with relations
   */
  async getUserById(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    return user;
  }
}
