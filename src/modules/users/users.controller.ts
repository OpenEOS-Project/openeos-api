import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  UpdateProfileDto,
  UpdatePreferencesDto,
  RequestEmailChangeDto,
  VerifyEmailChangeDto,
} from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update profile', description: 'Update the current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ) {
    const updatedUser = await this.usersService.updateProfile(user.id, dto);
    return { data: this.sanitizeUser(updatedUser) };
  }

  @Post('me/avatar')
  @ApiBearerAuth('JWT-auth')
  @UseInterceptors(FileInterceptor('avatar'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload avatar', description: 'Upload a new avatar image' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Avatar uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async uploadAvatar(
    @CurrentUser() user: User,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5MB
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|gif|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    // TODO: Implement file upload to storage service
    // For now, just return a placeholder
    const avatarUrl = `/uploads/avatars/${user.id}/${file.originalname}`;
    const updatedUser = await this.usersService.updateAvatar(user.id, avatarUrl);
    return { data: this.sanitizeUser(updatedUser) };
  }

  @Delete('me/avatar')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Delete avatar', description: 'Remove the current avatar' })
  @ApiResponse({ status: 200, description: 'Avatar deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteAvatar(@CurrentUser() user: User) {
    const updatedUser = await this.usersService.deleteAvatar(user.id);
    return { data: this.sanitizeUser(updatedUser) };
  }

  @Post('me/email/change')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Request email change', description: 'Request a verification email to change email address' })
  @ApiResponse({ status: 201, description: 'Verification email sent' })
  @ApiResponse({ status: 400, description: 'Invalid password or email already in use' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async requestEmailChange(
    @CurrentUser() user: User,
    @Body() dto: RequestEmailChangeDto,
  ) {
    await this.usersService.requestEmailChange(user.id, dto);
    return { message: 'Bestätigungslink wurde an die neue E-Mail-Adresse gesendet' };
  }

  @Post('me/email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Verify email change', description: 'Verify and complete email change' })
  @ApiResponse({ status: 200, description: 'Email changed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verifyEmailChange(@Body() dto: VerifyEmailChangeDto) {
    const updatedUser = await this.usersService.verifyEmailChange(dto.token);
    return {
      message: 'E-Mail-Adresse wurde erfolgreich geändert',
      data: this.sanitizeUser(updatedUser),
    };
  }

  @Get('me/preferences')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get preferences', description: 'Get user preferences' })
  @ApiResponse({ status: 200, description: 'User preferences' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getPreferences(@CurrentUser() user: User) {
    const preferences = await this.usersService.getPreferences(user.id);
    return { data: preferences };
  }

  @Patch('me/preferences')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update preferences', description: 'Update user preferences' })
  @ApiResponse({ status: 200, description: 'Preferences updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updatePreferences(
    @CurrentUser() user: User,
    @Body() dto: UpdatePreferencesDto,
  ) {
    const preferences = await this.usersService.updatePreferences(user.id, dto);
    return { data: preferences };
  }

  @Get('me/sessions')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get active sessions', description: 'Get list of active sessions/devices' })
  @ApiResponse({ status: 200, description: 'List of sessions' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getSessions(@CurrentUser() user: User) {
    const sessions = await this.usersService.getSessions(user.id);
    return {
      data: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        // TODO: Add device info when implemented
      })),
    };
  }

  @Delete('me/sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Revoke session', description: 'Revoke a specific session' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @ApiResponse({ status: 400, description: 'Session not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async revokeSession(
    @CurrentUser() user: User,
    @Param('id') sessionId: string,
  ) {
    await this.usersService.revokeSession(user.id, sessionId);
    return { message: 'Session wurde beendet' };
  }

  @Delete('me/sessions')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Revoke all other sessions', description: 'Revoke all sessions except the current one' })
  @ApiResponse({ status: 200, description: 'Sessions revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async revokeAllOtherSessions(@CurrentUser() user: User) {
    const count = await this.usersService.revokeAllOtherSessions(user.id);
    return { message: `${count} Session(s) wurden beendet` };
  }

  private sanitizeUser(user: User): Partial<User> {
    const {
      passwordHash,
      passwordResetToken,
      passwordResetExpiresAt,
      failedLoginAttempts,
      lockedUntil,
      twoFactorSecretEncrypted,
      twoFactorBackupCodesHash,
      pendingEmailToken,
      ...sanitized
    } = user;
    return sanitized;
  }
}
