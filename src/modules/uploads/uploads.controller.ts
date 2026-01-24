import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UploadsService } from './uploads.service';
import type { MulterFile } from './uploads.service';
import { UploadCategory } from './dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OrganizationGuard } from '../../common/guards/organization.guard';
import { Role } from '../../common/constants/roles.enum';
import { ErrorCodes } from '../../common/constants/error-codes';
import type { Organization } from '../../database/entities';

@ApiTags('Uploads')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/uploads')
@UseGuards(OrganizationGuard, RolesGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('image')
  @Roles(Role.ADMIN, Role.MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @CurrentOrganization() organization: Organization,
    @UploadedFile() file: MulterFile,
    @Query('category') category?: UploadCategory,
  ) {
    const result = await this.uploadsService.uploadImage(
      file,
      organization.id,
      category,
    );
    return { data: result };
  }

  @Delete(':filename')
  @Roles(Role.ADMIN, Role.MANAGER)
  async deleteImage(
    @CurrentOrganization() organization: Organization,
    @Param('filename') filename: string,
    @Query('category') category?: UploadCategory,
  ) {
    await this.uploadsService.deleteImage(organization.id, filename, category);
    return { data: { success: true } };
  }

  @Get(':category/:filename')
  @Roles(Role.ADMIN, Role.MANAGER, Role.CASHIER, Role.KITCHEN, Role.DELIVERY)
  async getImage(
    @CurrentOrganization() organization: Organization,
    @Param('category') category: string,
    @Param('filename') filename: string,
    @Res() res: unknown,
  ) {
    const filePath = await this.uploadsService.getImagePath(
      organization.id,
      filename,
      category,
    );

    if (!filePath) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Datei nicht gefunden',
      });
    }

    const response = res as Response;
    response.sendFile(filePath, { root: '.' });
  }
}
