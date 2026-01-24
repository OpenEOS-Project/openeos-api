import { IsEmail, IsEnum, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import type { OrganizationPermissions } from '../../../database/entities/user-organization.entity';

export class AddMemberDto {
  @ApiProperty({ example: 'max.mustermann@example.com', description: 'E-Mail-Adresse des neuen Mitglieds' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({ example: 'member', description: 'Rolle des Mitglieds in der Organisation', enum: OrganizationRole })
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role: OrganizationRole;

  @ApiPropertyOptional({ example: { canManageProducts: true, canViewReports: false }, description: 'Individuelle Berechtigungen' })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ example: 'admin', description: 'Rolle des Mitglieds in der Organisation', enum: OrganizationRole })
  @IsOptional()
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role?: OrganizationRole;

  @ApiPropertyOptional({ example: { canManageProducts: true, canViewReports: true }, description: 'Individuelle Berechtigungen' })
  @IsOptional()
  @IsObject()
  permissions?: OrganizationPermissions;
}
