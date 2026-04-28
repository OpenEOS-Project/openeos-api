import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AdminEventsService } from './admin-events.service';
import { QueryAdminEventsDto, MarkInvoicedDto } from './dto/admin-events.dto';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { User } from '../../database/entities';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin/events')
@UseGuards(SuperAdminGuard)
export class AdminEventsController {
  constructor(private readonly adminEventsService: AdminEventsService) {}

  @Get()
  async findAll(@Query() queryDto: QueryAdminEventsDto) {
    const result = await this.adminEventsService.findAllEvents(queryDto);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit),
        hasNext: result.page < Math.ceil(result.total / result.limit),
        hasPrev: result.page > 1,
      },
    };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const event = await this.adminEventsService.getEvent(id);
    return { data: event };
  }

  @Patch(':id/invoice')
  async markInvoiced(
    @Param('id') id: string,
    @Body() dto: MarkInvoicedDto,
    @CurrentUser() user: User,
  ) {
    const event = await this.adminEventsService.markInvoiced(id, user.id, dto);
    return { data: event };
  }

  @Delete(':id/invoice')
  async unmarkInvoiced(@Param('id') id: string) {
    const event = await this.adminEventsService.unmarkInvoiced(id);
    return { data: event };
  }
}
