import { IsOptional, IsDateString, IsEnum, IsInt, Min, Max, IsString, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminAction } from '../../../database/entities/admin-audit-log.entity';
import { CreditPaymentStatus } from '../../../database/entities/credit-purchase.entity';
import { InvoiceStatus } from '../../../database/entities/invoice.entity';
import { RentalAssignmentStatus } from '../../../database/entities/rental-assignment.entity';
import { RentalHardwareStatus, RentalHardwareType } from '../../../database/entities/rental-hardware.entity';

export class QueryOrganizationsDto {
  @ApiPropertyOptional({ example: 'Musterverein', description: 'Suchbegriff für Organisationsname' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryUsersDto {
  @ApiPropertyOptional({ example: 'max@example.com', description: 'Suchbegriff für Benutzername oder E-Mail' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: false, description: 'Filter nach gesperrten Benutzern' })
  @IsOptional()
  @Type(() => Boolean)
  isLocked?: boolean;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryPurchasesDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Organisations-ID' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'completed', description: 'Filter nach Zahlungsstatus', enum: CreditPaymentStatus })
  @IsOptional()
  @IsEnum(CreditPaymentStatus)
  status?: CreditPaymentStatus;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryInvoicesAdminDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Organisations-ID' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'paid', description: 'Filter nach Rechnungsstatus', enum: InvoiceStatus })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryAuditLogsDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Admin-Benutzer-ID' })
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440001', description: 'Filter nach Organisations-ID' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: 'adjust_credits', description: 'Filter nach Admin-Aktion', enum: AdminAction })
  @IsOptional()
  @IsEnum(AdminAction)
  action?: AdminAction;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryRentalHardwareDto {
  @ApiPropertyOptional({ example: 'printer', description: 'Filter nach Hardware-Typ', enum: RentalHardwareType })
  @IsOptional()
  @IsEnum(RentalHardwareType)
  type?: RentalHardwareType;

  @ApiPropertyOptional({ example: 'available', description: 'Filter nach Hardware-Status', enum: RentalHardwareStatus })
  @IsOptional()
  @IsEnum(RentalHardwareStatus)
  status?: RentalHardwareStatus;

  @ApiPropertyOptional({ example: 'Epson', description: 'Suchbegriff für Hardware-Name oder Modell' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class QueryRentalAssignmentsAdminDto {
  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440000', description: 'Filter nach Organisations-ID' })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ example: '550e8400-e29b-41d4-a716-446655440001', description: 'Filter nach Hardware-ID' })
  @IsOptional()
  @IsUUID()
  hardwareId?: string;

  @ApiPropertyOptional({ example: 'active', description: 'Filter nach Zuweisungsstatus', enum: RentalAssignmentStatus })
  @IsOptional()
  @IsEnum(RentalAssignmentStatus)
  status?: RentalAssignmentStatus;

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00.000Z', description: 'Startdatum für Filterung' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2024-12-31T23:59:59.000Z', description: 'Enddatum für Filterung' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// === Credit Packages Query DTO ===

export class QueryCreditPackagesDto {
  @ApiPropertyOptional({ example: 'credits', description: 'Suchbegriff für Paketname oder Slug' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: true, description: 'Filter nach aktiven Paketen' })
  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;

  @ApiPropertyOptional({ example: 1, description: 'Seitennummer für Pagination', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, description: 'Anzahl der Ergebnisse pro Seite', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
