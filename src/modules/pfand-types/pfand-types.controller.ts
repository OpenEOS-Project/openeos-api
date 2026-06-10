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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PfandTypesService } from './pfand-types.service';
import { CreatePfandTypeDto, UpdatePfandTypeDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Pfand Types')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/pfand-types')
export class PfandTypesController {
  constructor(private readonly pfandTypesService: PfandTypesService) {}

  @Post()
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

  @Get()
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

  @Get(':pfandTypeId')
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

  @Patch(':pfandTypeId')
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
