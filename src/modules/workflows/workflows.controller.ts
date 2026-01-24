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
import { WorkflowsService, WorkflowTriggerTypes, WorkflowNodeTypes } from './workflows.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreateWorkflowDto, UpdateWorkflowDto, TestWorkflowDto } from './dto';

@ApiTags('Workflows')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get('types')
  getTypes() {
    return {
      triggerTypes: Object.values(WorkflowTriggerTypes),
      nodeTypes: Object.values(WorkflowNodeTypes),
    };
  }

  @Post()
  create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() createDto: CreateWorkflowDto,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.create(organizationId, createDto, user);
  }

  @Get()
  findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.findAll(organizationId, user, pagination);
  }

  @Get(':workflowId')
  findOne(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.findOne(organizationId, workflowId, user);
  }

  @Patch(':workflowId')
  update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() updateDto: UpdateWorkflowDto,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.update(organizationId, workflowId, updateDto, user);
  }

  @Delete(':workflowId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.remove(organizationId, workflowId, user);
  }

  @Post(':workflowId/activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.activate(organizationId, workflowId, user);
  }

  @Post(':workflowId/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.deactivate(organizationId, workflowId, user);
  }

  @Post(':workflowId/test')
  @HttpCode(HttpStatus.OK)
  test(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() testDto: TestWorkflowDto,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.test(organizationId, workflowId, testDto, user);
  }

  @Get(':workflowId/runs')
  getWorkflowRuns(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: User,
  ) {
    return this.workflowsService.getWorkflowRuns(organizationId, workflowId, user, pagination);
  }
}
