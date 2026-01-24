import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrintersService } from './printers.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreatePrinterDto, UpdatePrinterDto } from './dto';

@ApiTags('Printers')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/printers')
export class PrintersController {
  constructor(private readonly printersService: PrintersService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePrinterDto,
    @CurrentUser() user: User,
  ) {
    return this.printersService.create(organizationId, createDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.printersService.findAll(organizationId, user, pagination);
  }

  @Get(':printerId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('printerId', ParseUUIDPipe) printerId: string,
    @CurrentUser() user: User,
  ) {
    return this.printersService.findOne(organizationId, printerId, user);
  }

  @Patch(':printerId')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('printerId', ParseUUIDPipe) printerId: string,
    @Body() updateDto: UpdatePrinterDto,
    @CurrentUser() user: User,
  ) {
    return this.printersService.update(organizationId, printerId, updateDto, user);
  }

  @Delete(':printerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('printerId', ParseUUIDPipe) printerId: string,
    @CurrentUser() user: User,
  ) {
    return this.printersService.remove(organizationId, printerId, user);
  }

  @Post(':printerId/test')
  @HttpCode(HttpStatus.OK)
  testPrint(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('printerId', ParseUUIDPipe) printerId: string,
    @CurrentUser() user: User,
  ) {
    return this.printersService.testPrint(organizationId, printerId, user);
  }
}
