import {
  IsString,
  IsOptional,
  IsArray,
  IsObject,
  IsBoolean,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { WorkflowNodeDto, WorkflowEdgeDto } from './create-workflow.dto';

export class UpdateWorkflowDto {
  @ApiPropertyOptional({ example: 'Küchenbonausgabe', description: 'Name des Workflows' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'Automatische Bonausgabe für Küchenprodukte', description: 'Beschreibung des Workflows' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ example: 'order.created', description: 'Auslöser-Typ des Workflows' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  triggerType?: string;

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
