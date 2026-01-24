import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrintJobsService } from './print-jobs.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { CreatePrintJobDto, QueryPrintJobsDto } from './dto';

@ApiTags('Print Jobs')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/print-jobs')
export class PrintJobsController {
  constructor(private readonly printJobsService: PrintJobsService) {}

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreatePrintJobDto,
    @CurrentUser() user: User,
  ) {
    return this.printJobsService.create(organizationId, createDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: QueryPrintJobsDto,
    @CurrentUser() user: User,
  ) {
    return this.printJobsService.findAll(organizationId, user, query);
  }

  @Get(':jobId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.printJobsService.findOne(organizationId, jobId, user);
  }

  @Post(':jobId/retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.printJobsService.retry(organizationId, jobId, user);
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.printJobsService.cancel(organizationId, jobId, user);
  }
}
