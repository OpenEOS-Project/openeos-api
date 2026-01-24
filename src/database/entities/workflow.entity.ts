import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { WorkflowRun } from './workflow-run.entity';

export interface WorkflowNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface WorkflowTriggerConfig {
  event?: string;
  conditions?: Record<string, unknown>;
  [key: string]: unknown;
}

@Entity('workflows')
@Index(['organizationId'])
export class Workflow extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'trigger_type', type: 'varchar', length: 50 })
  triggerType: string;

  @Column({ name: 'trigger_config', type: 'jsonb', default: {} })
  triggerConfig: WorkflowTriggerConfig;

  @Column({ type: 'jsonb', default: [] })
  nodes: WorkflowNode[];

  @Column({ type: 'jsonb', default: [] })
  edges: WorkflowEdge[];

  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive: boolean;

  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem: boolean;

  // Relations
  @ManyToOne(() => Organization, (org) => org.workflows, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @OneToMany(() => WorkflowRun, (run) => run.workflow)
  runs: WorkflowRun[];
}
