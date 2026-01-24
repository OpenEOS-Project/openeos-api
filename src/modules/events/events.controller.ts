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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto, CopyProductsDto } from './dto';
import { CurrentUser, CurrentOrganization } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('Events')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateEventDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.create(organizationId, createDto, user);
    return { data: event };
  }

  @Get()
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.eventsService.findAll(organizationId, user, pagination);
  }

  @Get(':eventId')
  async findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.findOne(organizationId, eventId, user);
    return { data: event };
  }

  @Patch(':eventId')
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() updateDto: UpdateEventDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.update(organizationId, eventId, updateDto, user);
    return { data: event };
  }

  @Delete(':eventId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    await this.eventsService.remove(organizationId, eventId, user);
  }

  // Event Lifecycle
  @Post(':eventId/activate')
  async activate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.activate(organizationId, eventId, user);
    return { data: event };
  }

  @Post(':eventId/complete')
  async complete(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.complete(organizationId, eventId, user);
    return { data: event };
  }

  @Post(':eventId/cancel')
  async cancel(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const event = await this.eventsService.cancel(organizationId, eventId, user);
    return { data: event };
  }

  // Credit Check
  @Get(':eventId/credits')
  async checkCredits(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() user: User,
  ) {
    const result = await this.eventsService.checkCredits(organizationId, eventId, user);
    return { data: result };
  }

  // Copy products from another event
  @Post(':eventId/copy-from/:sourceEventId')
  @ApiOperation({ summary: 'Kopiert Kategorien und Produkte von einem anderen Event' })
  async copyFromEvent(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Param('sourceEventId', ParseUUIDPipe) sourceEventId: string,
    @Body() copyDto: CopyProductsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.eventsService.copyFromEvent(
      organizationId,
      eventId,
      sourceEventId,
      copyDto,
      user,
    );
    return { data: result };
  }
}
