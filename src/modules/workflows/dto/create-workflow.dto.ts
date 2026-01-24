import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsBoolean,
  IsNumber,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// Position DTO for node positioning
export class NodePositionDto {
  @IsNumber()
  x: number;

  @IsNumber()
  y: number;
}

// WorkflowNode DTO with proper validation
export class WorkflowNodeDto {
  @ApiProperty({ example: 'node_1', description: 'Unique node identifier' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'order.created', description: 'Node type' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ example: {}, description: 'Node configuration data' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiProperty({ example: { x: 100, y: 200 }, description: 'Node position on canvas' })
  @ValidateNested()
  @Type(() => NodePositionDto)
  position: NodePositionDto;
}

// WorkflowEdge DTO with proper validation
export class WorkflowEdgeDto {
  @ApiProperty({ example: 'edge_1', description: 'Unique edge identifier' })
  @IsString()
  id: string;

  @ApiProperty({ example: 'node_1', description: 'Source node ID' })
  @IsString()
  source: string;

  @ApiProperty({ example: 'node_2', description: 'Target node ID' })
  @IsString()
  target: string;

  @ApiPropertyOptional({ example: 'output', description: 'Source handle ID' })
  @IsOptional()
  @IsString()
  sourceHandle?: string;

  @ApiPropertyOptional({ example: 'input', description: 'Target handle ID' })
  @IsOptional()
  @IsString()
  targetHandle?: string;

  @ApiPropertyOptional({ example: 'Yes', description: 'Edge label' })
  @IsOptional()
  @IsString()
  label?: string;
}

// TriggerConfig DTO
export class TriggerConfigDto {
  @ApiPropertyOptional({ description: 'Event type' })
  @IsOptional()
  @IsString()
  event?: string;

  @ApiPropertyOptional({ description: 'Conditions' })
  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  // Allow additional properties
  [key: string]: unknown;
}

export class CreateWorkflowDto {
  @ApiProperty({ example: 'Küchenbonausgabe', description: 'Name des Workflows' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: 'Automatische Bonausgabe für Küchenprodukte', description: 'Beschreibung des Workflows' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ example: 'order.created', description: 'Auslöser-Typ des Workflows' })
  @IsString()
  @MaxLength(50)
  triggerType: string;

  @ApiPropertyOptional({ example: { categories: ['kitchen'], status: 'confirmed' }, description: 'Konfiguration des Auslösers' })
  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: [{ id: 'node1', type: 'print', data: {}, position: { x: 0, y: 0 } }],
    description: 'Workflow-Knoten',
    type: [WorkflowNodeDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowNodeDto)
  nodes?: WorkflowNodeDto[];

  @ApiPropertyOptional({
    example: [{ id: 'edge1', source: 'node1', target: 'node2' }],
    description: 'Verbindungen zwischen Knoten',
    type: [WorkflowEdgeDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges?: WorkflowEdgeDto[];

  @ApiPropertyOptional({ example: true, description: 'Gibt an, ob der Workflow aktiv ist' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
