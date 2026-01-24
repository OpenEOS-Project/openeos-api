import { PartialType } from '@nestjs/swagger';
import { CreateShiftPlanDto } from './create-shift-plan.dto';

export class UpdateShiftPlanDto extends PartialType(CreateShiftPlanDto) {}
