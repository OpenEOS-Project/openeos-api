import { IsString, IsOptional, IsBoolean, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyTotpSetupDto {
  @ApiProperty({ example: '123456', description: '6-stelliger TOTP-Code' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Code muss aus 6 Ziffern bestehen' })
  token: string;
}

export class VerifyEmailOtpSetupDto {
  @ApiProperty({ example: '123456', description: '6-stelliger E-Mail-Code' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Code muss aus 6 Ziffern bestehen' })
  code: string;
}

export class Verify2FADto {
  @ApiProperty({ example: '123456', description: '6-stelliger Verifizierungscode oder Recovery-Code' })
  @IsString()
  @Length(6, 11) // 6 for OTP, 9 for recovery code with dash (xxxx-xxxx)
  code: string;

  @ApiPropertyOptional({ example: true, description: 'Gerät als vertrauenswürdig markieren' })
  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;

  @ApiPropertyOptional({ example: 'abc123...', description: 'Geräte-Fingerabdruck' })
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @ApiPropertyOptional({ example: 'MacBook Pro', description: 'Gerätename' })
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional({ example: 'Chrome 120', description: 'Browser' })
  @IsOptional()
  @IsString()
  browser?: string;

  @ApiPropertyOptional({ example: 'macOS 14.0', description: 'Betriebssystem' })
  @IsOptional()
  @IsString()
  os?: string;
}

export class Disable2FADto {
  @ApiProperty({ example: 'MySecurePassword123!', description: 'Aktuelles Passwort zur Bestätigung' })
  @IsString()
  password: string;
}

// Response DTOs
export class TotpSetupResponseDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP', description: 'TOTP-Secret für manuelle Eingabe' })
  secret: string;

  @ApiProperty({ example: 'data:image/png;base64,...', description: 'QR-Code als Data-URL' })
  qrCodeDataUrl: string;

  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP', description: 'Secret für manuelle Eingabe' })
  manualEntryKey: string;
}

export class RecoveryCodesResponseDto {
  @ApiProperty({ example: ['abcd-1234', 'efgh-5678'], description: 'Recovery-Codes (einmalig anzeigen!)' })
  codes: string[];
}

export class TwoFactorStatusResponseDto {
  @ApiProperty({ example: true, description: '2FA aktiviert' })
  enabled: boolean;

  @ApiProperty({ example: 'totp', description: '2FA-Methode', enum: ['totp', 'email', null] })
  method: 'totp' | 'email' | null;

  @ApiProperty({ example: true, description: 'Recovery-Codes vorhanden' })
  hasRecoveryCodes: boolean;
}

export class TrustedDeviceResponseDto {
  @ApiProperty({ example: 'uuid', description: 'Geräte-ID' })
  id: string;

  @ApiProperty({ example: 'MacBook Pro', description: 'Gerätename' })
  deviceName: string | null;

  @ApiProperty({ example: 'Chrome 120', description: 'Browser' })
  browser: string | null;

  @ApiProperty({ example: 'macOS 14.0', description: 'Betriebssystem' })
  os: string | null;

  @ApiProperty({ example: '192.168.1.1', description: 'IP-Adresse' })
  ipAddress: string | null;

  @ApiProperty({ example: '2024-01-15T10:00:00Z', description: 'Zuletzt verwendet' })
  lastUsedAt: Date;

  @ApiProperty({ example: '2024-02-15T10:00:00Z', description: 'Läuft ab am' })
  expiresAt: Date;

  @ApiProperty({ example: '2024-01-15T10:00:00Z', description: 'Erstellt am' })
  createdAt: Date;
}

export class TwoFactorRequiredResponseDto {
  @ApiProperty({ example: true, description: '2FA erforderlich' })
  twoFactorRequired: boolean;

  @ApiProperty({ example: 'totp', description: '2FA-Methode', enum: ['totp', 'email'] })
  method: 'totp' | 'email';

  @ApiProperty({ example: 'temp-token-uuid', description: 'Temporärer Token für 2FA-Verifizierung' })
  twoFactorToken: string;
}
