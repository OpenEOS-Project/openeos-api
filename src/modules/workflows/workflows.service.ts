import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow, WorkflowRun, User, UserOrganization } from '../../database/entities';
import { WorkflowRunStatus } from '../../database/entities/workflow-run.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PaginationDto, PaginatedResult, createPaginatedResult } from '../../common/dto/pagination.dto';
import { CreateWorkflowDto, UpdateWorkflowDto, TestWorkflowDto } from './dto';
import { GatewayService } from '../gateway/gateway.service';

// Available trigger types
export const WorkflowTriggerTypes = {
  ORDER_CREATED: 'order_created',
  ORDER_ITEM_READY: 'order_item_ready',
  ORDER_COMPLETED: 'order_completed',
  PAYMENT_RECEIVED: 'payment_received',
  LOW_STOCK: 'low_stock',
  MANUAL: 'manual',
} as const;

// Available node types
export const WorkflowNodeTypes = {
  TRIGGER: 'trigger',
  CONDITION: 'condition',
  PRINT: 'print',
  NOTIFY: 'notify',
  WEBHOOK: 'webhook',
  DELAY: 'delay',
  NOTIFY_BROADCAST: 'notify.broadcast',
} as const;

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    @InjectRepository(WorkflowRun)
    private readonly workflowRunRepository: Repository<WorkflowRun>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    organizationId: string,
    createDto: CreateWorkflowDto,
    user: User,
  ): Promise<Workflow> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const workflow = this.workflowRepository.create({
      organizationId,
      name: createDto.name,
      description: createDto.description || null,
      triggerType: createDto.triggerType,
      triggerConfig: createDto.triggerConfig || {},
      nodes: createDto.nodes || [],
      edges: createDto.edges || [],
      isActive: createDto.isActive || false,
      isSystem: false,
    });

    await this.workflowRepository.save(workflow);
    this.logger.log(`Workflow created: ${workflow.name} (${workflow.id})`);

    return workflow;
  }

  async findAll(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Workflow>> {
    await this.checkMembership(organizationId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.workflowRepository.findAndCount({
      where: { organizationId },
      skip,
      take: limit,
      order: { name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(organizationId: string, workflowId: string, user: User): Promise<Workflow> {
    await this.checkMembership(organizationId, user.id);

    const workflow = await this.workflowRepository.findOne({
      where: { id: workflowId, organizationId },
    });

    if (!workflow) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Workflow nicht gefunden',
      });
    }

    return workflow;
  }

  async update(
    organizationId: string,
    workflowId: string,
    updateDto: UpdateWorkflowDto,
    user: User,
  ): Promise<Workflow> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const workflow = await this.findOne(organizationId, workflowId, user);

    if (workflow.isSystem) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'System-Workflows können nicht bearbeitet werden',
      });
    }

    Object.assign(workflow, updateDto);
    await this.workflowRepository.save(workflow);

    this.logger.log(`Workflow updated: ${workflow.name} (${workflow.id})`);

    return workflow;
  }

  async remove(organizationId: string, workflowId: string, user: User): Promise<void> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const workflow = await this.findOne(organizationId, workflowId, user);

    if (workflow.isSystem) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'System-Workflows können nicht gelöscht werden',
      });
    }

    await this.workflowRepository.remove(workflow);
    this.logger.log(`Workflow deleted: ${workflow.name} (${workflow.id})`);
  }

  async activate(
    organizationId: string,
    workflowId: string,
    user: User,
  ): Promise<Workflow> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const workflow = await this.findOne(organizationId, workflowId, user);

    // Validate workflow has nodes
    if (!workflow.nodes || workflow.nodes.length === 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Workflow muss mindestens einen Knoten haben',
      });
    }

    workflow.isActive = true;
    await this.workflowRepository.save(workflow);

    this.logger.log(`Workflow activated: ${workflow.name} (${workflow.id})`);

    return workflow;
  }

  async deactivate(
    organizationId: string,
    workflowId: string,
    user: User,
  ): Promise<Workflow> {
    await this.checkRole(organizationId, user.id, OrganizationRole.ADMIN);

    const workflow = await this.findOne(organizationId, workflowId, user);
    workflow.isActive = false;
    await this.workflowRepository.save(workflow);

    this.logger.log(`Workflow deactivated: ${workflow.name} (${workflow.id})`);

    return workflow;
  }

  async test(
    organizationId: string,
    workflowId: string,
    testDto: TestWorkflowDto,
    user: User,
  ): Promise<WorkflowRun> {
    await this.checkRole(organizationId, user.id, OrganizationRole.MANAGER);

    const workflow = await this.findOne(organizationId, workflowId, user);

    // Create a test run
    const run = await this.executeWorkflow(workflow, 'test', testDto.testData || {});

    return run;
  }

  async getWorkflowRuns(
    organizationId: string,
    workflowId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<WorkflowRun>> {
    await this.checkMembership(organizationId, user.id);

    // Verify workflow belongs to organization
    await this.findOne(organizationId, workflowId, user);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.workflowRunRepository.findAndCount({
      where: { workflowId },
      skip,
      take: limit,
      order: { startedAt: 'DESC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  // Method to be called by other services when events occur
  async triggerWorkflows(
    organizationId: string,
    triggerType: string,
    triggerData: Record<string, unknown>,
  ): Promise<void> {
    const workflows = await this.workflowRepository.find({
      where: {
        organizationId,
        triggerType,
        isActive: true,
      },
    });

    for (const workflow of workflows) {
      try {
        await this.executeWorkflow(workflow, triggerType, triggerData);
      } catch (error) {
        this.logger.error(
          `Failed to execute workflow ${workflow.id}: ${error.message}`,
        );
      }
    }
  }

  private async executeWorkflow(
    workflow: Workflow,
    triggerEvent: string,
    triggerData: Record<string, unknown>,
  ): Promise<WorkflowRun> {
    const run = this.workflowRunRepository.create({
      workflowId: workflow.id,
      triggerEvent,
      triggerData,
      status: WorkflowRunStatus.RUNNING,
      startedAt: new Date(),
      executionLog: [],
    });

    await this.workflowRunRepository.save(run);

    try {
      // Execute nodes in order
      for (const node of workflow.nodes) {
        const nodeResult = await this.executeNode(node, triggerData, workflow.organizationId);
        run.executionLog.push({
          nodeId: node.id,
          status: nodeResult.success ? 'completed' : 'failed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          output: nodeResult.output,
          error: nodeResult.error,
        });

        if (!nodeResult.success) {
          run.status = WorkflowRunStatus.FAILED;
          run.error = nodeResult.error || 'Node execution failed';
          break;
        }
      }

      if (run.status === WorkflowRunStatus.RUNNING) {
        run.status = WorkflowRunStatus.COMPLETED;
      }
    } catch (error) {
      run.status = WorkflowRunStatus.FAILED;
      run.error = error.message;
    }

    run.completedAt = new Date();
    await this.workflowRunRepository.save(run);

    this.logger.log(
      `Workflow run ${run.id} for ${workflow.name}: ${run.status}`,
    );

    return run;
  }

  private async executeNode(
    node: { id: string; type: string; data: Record<string, unknown> },
    context: Record<string, unknown>,
    organizationId: string,
  ): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
    // Basic node execution - in production, this would be more sophisticated
    switch (node.type) {
      case WorkflowNodeTypes.TRIGGER:
        return { success: true, output: { triggered: true } };

      case WorkflowNodeTypes.CONDITION:
        // Simple condition evaluation
        const condition = node.data.condition as string;
        // For now, just return success - real implementation would evaluate condition
        return { success: true, output: { conditionMet: true } };

      case WorkflowNodeTypes.PRINT:
        // Log print action - real implementation would create print job
        this.logger.log(`Print action triggered: ${JSON.stringify(node.data)}`);
        return { success: true, output: { printed: true } };

      case WorkflowNodeTypes.NOTIFY:
        // Log notification - real implementation would send notification
        this.logger.log(`Notification triggered: ${JSON.stringify(node.data)}`);
        return { success: true, output: { notified: true } };

      case WorkflowNodeTypes.WEBHOOK:
        // Log webhook - real implementation would call webhook
        this.logger.log(`Webhook triggered: ${JSON.stringify(node.data)}`);
        return { success: true, output: { webhookCalled: true } };

      case WorkflowNodeTypes.DELAY:
        // Simulated delay - real implementation would use scheduling
        const delayMs = (node.data.seconds as number || 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 5000)));
        return { success: true, output: { delayed: true } };

      case WorkflowNodeTypes.NOTIFY_BROADCAST:
        // Send broadcast message to all connected devices
        try {
          const message = node.data.message as string || 'Workflow notification';
          const messageType = (node.data.type as 'info' | 'warning' | 'success' | 'error') || 'info';
          const title = node.data.title as string | undefined;

          const broadcast = this.gatewayService.broadcastMessage(organizationId, {
            message,
            type: messageType,
            title,
            senderName: 'Workflow',
          });

          this.logger.log(`Broadcast sent to organization ${organizationId}: ${message}`);
          return { success: true, output: { broadcastId: broadcast.id, message } };
        } catch (error) {
          return { success: false, error: `Broadcast failed: ${error.message}` };
        }

      default:
        return { success: false, error: `Unknown node type: ${node.type}` };
    }
  }

  private async checkMembership(organizationId: string, userId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }

  private async checkRole(
    organizationId: string,
    userId: string,
    requiredRole: OrganizationRole,
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    const roleHierarchy: Record<OrganizationRole, number> = {
      [OrganizationRole.ADMIN]: 100,
      [OrganizationRole.MANAGER]: 80,
      [OrganizationRole.CASHIER]: 40,
      [OrganizationRole.KITCHEN]: 20,
      [OrganizationRole.DELIVERY]: 20,
    };

    if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
