import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Workflow } from './workflow.entity';

export enum WorkflowRunStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface WorkflowExecutionLog {
  nodeId: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  output?: Record<string, unknown>;
}

@Entity('workflow_runs')
@Index(['workflowId'])
export class WorkflowRun extends BaseEntity {
  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @Column({ name: 'trigger_event', type: 'varchar', length: 50 })
  triggerEvent: string;

  @Column({ name: 'trigger_data', type: 'jsonb', default: {} })
  triggerData: Record<string, unknown>;

  @Column({ type: 'enum', enum: WorkflowRunStatus, enumName: 'workflow_run_status', default: WorkflowRunStatus.RUNNING })
  status: WorkflowRunStatus;

  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  startedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ name: 'execution_log', type: 'jsonb', default: [] })
  executionLog: WorkflowExecutionLog[];

  // Relations
  @ManyToOne(() => Workflow, (workflow) => workflow.runs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow: Workflow;
}
