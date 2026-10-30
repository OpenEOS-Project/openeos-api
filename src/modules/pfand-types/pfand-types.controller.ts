import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PfandTypesService } from './pfand-types.service';
import { CreatePfandTypeDto, UpdatePfandTypeDto } from './dto';
import { CurrentUser, ApiTokenAccess } from '../../common/decorators';
import { TokenScope } from '../api-tokens/api-scopes';
import { User } from '../../database/entities';

@ApiTags('Pfand Types')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/pfand-types')
export class PfandTypesController {
  constructor(private readonly pfandTypesService: PfandTypesService) {}

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post()
  @ApiOperation({
    operationId: 'createPfandType',
    summary: 'Pfandart anlegen',
    description:
      'Legt eine Pfandart (z. B. Glas 2 €) für die Organisation an. Scope `catalog:write` und Modulrecht Pfand.',
  })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePfandTypeDto,
    @CurrentUser() user: User,
  ) {
    const pfandType = await this.pfandTypesService.create(
      organizationId,
      createDto,
      user,
    );
    return { data: pfandType };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get()
  @ApiOperation({
    operationId: 'listPfandTypes',
    summary: 'Pfandarten auflisten',
    description:
      'Alle Pfandarten der Organisation, ohne Seitenwechsel. Scope `read`.',
  })
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    const pfandTypes = await this.pfandTypesService.findAll(
      organizationId,
      user,
    );
    return { data: pfandTypes };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get(':pfandTypeId')
  @ApiOperation({
    operationId: 'getPfandType',
    summary: 'Pfandart abrufen',
    description: 'Eine Pfandart der Organisation. Scope `read`.',
  })
  @ApiParam({
    name: 'pfandTypeId',
    description: 'ID der Pfandart',
    format: 'uuid',
  })
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('pfandTypeId', ParseUUIDPipe) pfandTypeId: string,
    @CurrentUser() user: User,
  ) {
    const pfandType = await this.pfandTypesService.findOne(
      organizationId,
      pfandTypeId,
      user,
    );
    return { data: pfandType };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch(':pfandTypeId')
  @ApiOperation({
    operationId: 'updatePfandType',
    summary: 'Pfandart ändern',
    description:
      'Ändert Name, Betrag oder Sichtbarkeit einer Pfandart. Scope `catalog:write`.',
  })
  @ApiParam({
    name: 'pfandTypeId',
    description: 'ID der Pfandart',
    format: 'uuid',
  })
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('pfandTypeId', ParseUUIDPipe) pfandTypeId: string,
    @Body() updateDto: UpdatePfandTypeDto,
    @CurrentUser() user: User,
  ) {
    const pfandType = await this.pfandTypesService.update(
      organizationId,
      pfandTypeId,
      updateDto,
      user,
    );
    return { data: pfandType };
  }

  @Delete(':pfandTypeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('pfandTypeId', ParseUUIDPipe) pfandTypeId: string,
    @CurrentUser() user: User,
  ) {
    await this.pfandTypesService.remove(organizationId, pfandTypeId, user);
  }
}
