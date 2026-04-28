import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  IsUUID,
  IsBoolean,
  Min,
  Max,
  MaxLength,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RentalHardwareType, RentalHardwareStatus } from '../../../database/entities/rental-hardware.entity';
import type { RentalHardwareConfig } from '../../../database/entities/rental-hardware.entity';

export class SetDiscountDto {
  @ApiProperty({ example: 15, description: 'Rabattprozentsatz (0-100)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercent: number;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Gültigkeitsdatum des Rabatts' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ example: 'Treuebonus für langjährigen Kunden', description: 'Grund für den Rabatt' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AccessOrganizationDto {
  @ApiProperty({ example: '123456', description: 'Support-PIN für den Zugriff auf die Organisation' })
  @IsString()
  @MaxLength(10)
  supportPin: string;
}

export class CreateRentalHardwareDto {
  @ApiProperty({ example: 'printer', description: 'Typ der Miet-Hardware', enum: RentalHardwareType })
  @IsEnum(RentalHardwareType)
  type: RentalHardwareType;

  @ApiProperty({ example: 'Bondrucker Epson TM-T88VI', description: 'Name der Hardware' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'SN-2024-001234', description: 'Seriennummer der Hardware' })
  @IsString()
  @MaxLength(100)
  serialNumber: string;

  @ApiPropertyOptional({ example: 'Epson TM-T88VI', description: 'Modellbezeichnung' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;

  @ApiPropertyOptional({ example: 'Thermobondrucker für Kassenbons', description: 'Beschreibung der Hardware' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 5.99, description: 'Tagesmiete in Euro' })
  @IsNumber()
  @Min(0)
  dailyRate: number;

  @ApiPropertyOptional({ example: { paperWidth: 80, dpi: 203 }, description: 'Hardware-Konfiguration' })
  @IsOptional()
  @IsObject()
  hardwareConfig?: RentalHardwareConfig;

  @ApiPropertyOptional({ description: 'ID des verknüpften Geräts (Printer Agent)' })
  @IsOptional()
  @IsUUID()
  deviceId?: string | null;

  @ApiPropertyOptional({ example: 'Inkl. USB-Kabel und Netzteil', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateRentalHardwareDto {
  @ApiPropertyOptional({ example: 'Bondrucker Epson TM-T88VI', description: 'Name der Hardware' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'Epson TM-T88VI', description: 'Modellbezeichnung' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;

  @ApiPropertyOptional({ example: 'Thermobondrucker für Kassenbons', description: 'Beschreibung der Hardware' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 5.99, description: 'Tagesmiete in Euro' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyRate?: number;

  @ApiPropertyOptional({ example: 'available', description: 'Status der Hardware', enum: RentalHardwareStatus })
  @IsOptional()
  @IsEnum(RentalHardwareStatus)
  status?: RentalHardwareStatus;

  @ApiPropertyOptional({ example: { paperWidth: 80, dpi: 203 }, description: 'Hardware-Konfiguration' })
  @IsOptional()
  @IsObject()
  hardwareConfig?: RentalHardwareConfig;

  @ApiPropertyOptional({ description: 'ID des verknüpften Geräts (Printer Agent)' })
  @IsOptional()
  @IsUUID()
  deviceId?: string | null;

  @ApiPropertyOptional({ example: 'Inkl. USB-Kabel und Netzteil', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateRentalAssignmentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'ID der Miet-Hardware' })
  @IsUUID()
  rentalHardwareId: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440001', description: 'ID der Organisation' })
  @IsUUID()
  organizationId: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440002', description: 'ID des Events (optional)' })
  @IsOptional()
  @IsUUID()
  eventId?: string;

  @ApiProperty({ example: '2024-07-01T00:00:00.000Z', description: 'Startdatum der Miete' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2024-07-03T23:59:59.000Z', description: 'Enddatum der Miete' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({ example: 'Lieferung an Standort erfolgt', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateRentalAssignmentDto {
  @ApiPropertyOptional({ example: '2024-07-01T00:00:00.000Z', description: 'Startdatum der Miete' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-07-03T23:59:59.000Z', description: 'Enddatum der Miete' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 'Verlängerung genehmigt', description: 'Zusätzliche Notizen' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateOrganizationAdminDto {
  @ApiPropertyOptional({ example: 'Musterverein e.V.', description: 'Name der Organisation' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob die Organisation aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { maxDevices: 5, maxUsers: 10 }, description: 'Zusätzliche Einstellungen' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

// === Subscription Config DTOs ===

export class CreateSubscriptionConfigDto {
  @ApiProperty({ example: 'Pro Plan', description: 'Name des Abo-Plans' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Unser beliebtester Plan für Vereine', description: 'Beschreibung des Plans' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 29.99, description: 'Monatlicher Preis in Euro' })
  @IsNumber()
  @Min(0)
  priceMonthly: number;

  @ApiProperty({ example: 50, description: 'Anzahl der Credits pro Monat' })
  @IsNumber()
  @Min(0)
  creditsPerMonth: number;

  @ApiPropertyOptional({ example: true, description: 'Ob der Plan aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { maxEvents: 10, maxUsers: 20 }, description: 'Features des Plans' })
  @IsOptional()
  @IsObject()
  features?: Record<string, unknown>;
}

export class UpdateSubscriptionConfigDto {
  @ApiPropertyOptional({ example: 'Pro Plan', description: 'Name des Abo-Plans' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Unser beliebtester Plan für Vereine', description: 'Beschreibung des Plans' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 29.99, description: 'Monatlicher Preis in Euro' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceMonthly?: number;

  @ApiPropertyOptional({ example: 50, description: 'Anzahl der Credits pro Monat' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditsPerMonth?: number;

  @ApiPropertyOptional({ example: true, description: 'Ob der Plan aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { maxEvents: 10, maxUsers: 20 }, description: 'Features des Plans' })
  @IsOptional()
  @IsObject()
  features?: Record<string, unknown>;
}

