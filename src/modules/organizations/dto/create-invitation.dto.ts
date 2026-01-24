import { IsEmail, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';

export class CreateInvitationDto {
  @ApiProperty({ example: 'max.mustermann@example.com', description: 'E-Mail-Adresse des einzuladenden Benutzers' })
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email: string;

  @ApiProperty({ example: 'member', description: 'Rolle für das neue Mitglied', enum: OrganizationRole })
  @IsEnum(OrganizationRole, { message: 'Ungültige Rolle' })
  role: OrganizationRole;
}
