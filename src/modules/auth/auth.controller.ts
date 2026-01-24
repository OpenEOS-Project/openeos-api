import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Res,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import type { Response, Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  LoginResponseDto,
  RegisterResponseDto,
  RefreshResponseDto,
  MessageResponseDto,
  CurrentUserResponseDto,
  VerifyTotpSetupDto,
  VerifyEmailOtpSetupDto,
  Verify2FADto,
  Disable2FADto,
  TotpSetupResponseDto,
  RecoveryCodesResponseDto,
  TwoFactorStatusResponseDto,
  TrustedDeviceResponseDto,
} from './dto';
import { Public, CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly twoFactorService: TwoFactorService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user', description: 'Create a new user account with email and password' })
  @ApiResponse({ status: 201, description: 'User successfully registered', type: RegisterResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.register(registerDto);

    // Set refresh token as httpOnly cookie
    this.setRefreshTokenCookie(response, result.refreshToken);

    return {
      user: this.sanitizeUser(result.user),
      accessToken: result.accessToken,
    };
  }

  @Public()
  @UseGuards(AuthGuard('local'))
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user', description: 'Authenticate user with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful', type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 423, description: 'Account locked' })
  async login(
    @Body() _loginDto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = request.user as User;
    const result = await this.authService.login(user);

    // Set refresh token as httpOnly cookie
    this.setRefreshTokenCookie(response, result.refreshToken);

    return {
      user: this.sanitizeUser(result.user),
      accessToken: result.accessToken,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token', description: 'Get a new access token using refresh token' })
  @ApiResponse({ status: 200, description: 'New access token generated', type: RefreshResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Try to get refresh token from cookie first, then from body
    const refreshToken =
      request.cookies?.refreshToken || refreshTokenDto.refreshToken;

    if (!refreshToken) {
      return {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Refresh-Token nicht gefunden',
      };
    }

    const tokens = await this.authService.refreshTokens(refreshToken);

    // Set new refresh token as httpOnly cookie
    this.setRefreshTokenCookie(response, tokens.refreshToken);

    return {
      accessToken: tokens.accessToken,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Logout user', description: 'Invalidate refresh token and clear cookie' })
  @ApiResponse({ status: 200, description: 'Logout successful', type: MessageResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(
    @CurrentUser() user: User,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = request.cookies?.refreshToken;
    await this.authService.logout(user.id, refreshToken);

    // Clear refresh token cookie
    response.clearCookie('refreshToken', {
      httpOnly: true,
      secure: this.configService.get('nodeEnv') === 'production',
      sameSite: 'lax',
      path: '/',
    });

    return {
      message: 'Erfolgreich abgemeldet',
    };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset', description: 'Send password reset email if account exists' })
  @ApiResponse({ status: 200, description: 'Reset email sent if account exists', type: MessageResponseDto })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    await this.authService.forgotPassword(forgotPasswordDto);

    return {
      message: 'Falls ein Konto mit dieser E-Mail existiert, wurde eine Anleitung zum Zurücksetzen des Passworts gesendet',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password', description: 'Reset password using token from email' })
  @ApiResponse({ status: 200, description: 'Password reset successful', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    await this.authService.resetPassword(resetPasswordDto);

    return {
      message: 'Passwort wurde erfolgreich zurückgesetzt',
    };
  }

  @Patch('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Change password', description: 'Change password for authenticated user' })
  @ApiResponse({ status: 200, description: 'Password changed successfully', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid current password' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    await this.authService.changePassword(user.id, changePasswordDto);

    return {
      message: 'Passwort wurde erfolgreich geändert',
    };
  }

  @Get('me')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user', description: 'Get profile of authenticated user' })
  @ApiResponse({ status: 200, description: 'User profile', type: CurrentUserResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@CurrentUser() user: User) {
    const fullUser = await this.authService.getCurrentUser(user.id);

    return {
      user: this.sanitizeUser(fullUser),
    };
  }

  @Get('me/invitations')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get pending invitations', description: 'Get all pending organization invitations for the current user' })
  @ApiResponse({ status: 200, description: 'List of pending invitations' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getPendingInvitations(@CurrentUser() user: User) {
    const invitations = await this.authService.getPendingInvitations(user.id);

    // Filter expired invitations
    const validInvitations = invitations.filter(inv => inv.expiresAt > new Date());

    return {
      data: validInvitations,
    };
  }

  // ==========================================
  // 2FA Endpoints
  // ==========================================

  @Get('2fa/status')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get 2FA status', description: 'Get the current 2FA status for the user' })
  @ApiResponse({ status: 200, description: '2FA status', type: TwoFactorStatusResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async get2FAStatus(@CurrentUser() user: User): Promise<TwoFactorStatusResponseDto> {
    return this.twoFactorService.get2FAStatus(user.id);
  }

  @Post('2fa/setup/totp')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Start TOTP setup', description: 'Generate QR code and secret for TOTP authentication' })
  @ApiResponse({ status: 201, description: 'TOTP setup data', type: TotpSetupResponseDto })
  @ApiResponse({ status: 400, description: '2FA already enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async setupTotp(@CurrentUser() user: User): Promise<TotpSetupResponseDto> {
    return this.twoFactorService.setupTotp(user.id);
  }

  @Post('2fa/setup/totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Verify TOTP setup', description: 'Verify TOTP code and enable 2FA' })
  @ApiResponse({ status: 200, description: 'Recovery codes', type: RecoveryCodesResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid code or 2FA already enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verifyTotpSetup(
    @CurrentUser() user: User,
    @Body() dto: VerifyTotpSetupDto,
  ): Promise<RecoveryCodesResponseDto> {
    return this.twoFactorService.verifyTotpSetup(user.id, dto.token);
  }

  @Post('2fa/setup/email')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Start Email OTP setup', description: 'Send verification code to email for 2FA setup' })
  @ApiResponse({ status: 201, description: 'OTP sent', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: '2FA already enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async setupEmailOtp(@CurrentUser() user: User): Promise<{ message: string }> {
    await this.twoFactorService.setupEmailOtp(user.id);
    return { message: 'Verifizierungscode wurde per E-Mail gesendet' };
  }

  @Post('2fa/setup/email/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Verify Email OTP setup', description: 'Verify email code and enable 2FA' })
  @ApiResponse({ status: 200, description: 'Recovery codes', type: RecoveryCodesResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid code or 2FA already enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verifyEmailOtpSetup(
    @CurrentUser() user: User,
    @Body() dto: VerifyEmailOtpSetupDto,
  ): Promise<RecoveryCodesResponseDto> {
    return this.twoFactorService.verifyEmailOtpSetup(user.id, dto.code);
  }

  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Verify 2FA code', description: 'Verify 2FA code during login' })
  @ApiResponse({ status: 200, description: '2FA verified', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid code' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verify2FA(
    @CurrentUser() user: User,
    @Body() dto: Verify2FADto,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    const ip = request.ip || request.socket.remoteAddress;
    await this.twoFactorService.verify2FA(
      user.id,
      dto.code,
      dto.trustDevice,
      dto.deviceFingerprint,
      {
        name: dto.deviceName,
        browser: dto.browser,
        os: dto.os,
        ip,
      },
    );
    return { message: '2FA erfolgreich verifiziert' };
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Disable 2FA', description: 'Disable 2FA for the user' })
  @ApiResponse({ status: 200, description: '2FA disabled', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: '2FA not enabled or invalid password' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async disable2FA(
    @CurrentUser() user: User,
    @Body() dto: Disable2FADto,
  ): Promise<{ message: string }> {
    await this.twoFactorService.disable2FA(user.id, dto.password);
    return { message: '2FA wurde deaktiviert' };
  }

  @Post('2fa/recovery/generate')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Generate new recovery codes', description: 'Generate new recovery codes (invalidates old ones)' })
  @ApiResponse({ status: 201, description: 'New recovery codes', type: RecoveryCodesResponseDto })
  @ApiResponse({ status: 400, description: '2FA not enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async regenerateRecoveryCodes(@CurrentUser() user: User): Promise<RecoveryCodesResponseDto> {
    return this.twoFactorService.regenerateRecoveryCodes(user.id);
  }

  @Get('2fa/trusted-devices')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get trusted devices', description: 'Get list of trusted devices for 2FA' })
  @ApiResponse({ status: 200, description: 'List of trusted devices', type: [TrustedDeviceResponseDto] })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getTrustedDevices(@CurrentUser() user: User) {
    const devices = await this.twoFactorService.getTrustedDevices(user.id);
    return { data: devices };
  }

  @Delete('2fa/trusted-devices/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Remove trusted device', description: 'Remove a trusted device' })
  @ApiResponse({ status: 200, description: 'Device removed', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Device not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async removeTrustedDevice(
    @CurrentUser() user: User,
    @Param('id') deviceId: string,
  ): Promise<{ message: string }> {
    await this.twoFactorService.removeTrustedDevice(user.id, deviceId);
    return { message: 'Gerät wurde entfernt' };
  }

  @Post('2fa/send-login-otp')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Send login OTP', description: 'Send OTP code to email for 2FA login' })
  @ApiResponse({ status: 200, description: 'OTP sent', type: MessageResponseDto })
  @ApiResponse({ status: 400, description: 'Email 2FA not enabled' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async sendLoginOtp(@CurrentUser() user: User): Promise<{ message: string }> {
    await this.twoFactorService.sendLoginOtp(user.id);
    return { message: 'Verifizierungscode wurde per E-Mail gesendet' };
  }

  private setRefreshTokenCookie(response: Response, token: string): void {
    const isProduction = this.configService.get('nodeEnv') === 'production';
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    response.cookie('refreshToken', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
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
