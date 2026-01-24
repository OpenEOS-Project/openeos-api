import { IsObject, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TestWorkflowDto {
  @ApiPropertyOptional({ example: { orderId: '550e8400-e29b-41d4-a716-446655440000', orderNumber: 'B-001' }, description: 'Testdaten für den Workflow' })
  @IsOptional()
  @IsObject()
  testData?: Record<string, unknown>;
}
