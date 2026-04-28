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
import { ProductionStationsService } from './production-stations.service';
import { CreateProductionStationDto, UpdateProductionStationDto } from './dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('Production Stations')
@ApiBearerAuth('JWT-auth')
@Controller('events/:eventId/production-stations')
export class ProductionStationsController {
  constructor(private readonly productionStationsService: ProductionStationsService) {}

  @Post()
  async create(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() createDto: CreateProductionStationDto,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.create(eventId, createDto, user);
    return { data: station };
  }

  @Get()
  async findAll(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const stations = await this.productionStationsService.findAll(eventId, user);
    return { data: stations };
  }

  @Get(':stationId')
  async findOne(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.findOne(eventId, stationId, user);
    return { data: station };
  }

  @Patch(':stationId')
  async update(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @Body() updateDto: UpdateProductionStationDto,
    @CurrentUser() user: User,
  ) {
    const station = await this.productionStationsService.update(eventId, stationId, updateDto, user);
    return { data: station };
  }

  @Delete(':stationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('stationId', ParseUUIDPipe) stationId: string,
    @CurrentUser() user: User,
  ) {
    await this.productionStationsService.remove(eventId, stationId, user);
  }
}
