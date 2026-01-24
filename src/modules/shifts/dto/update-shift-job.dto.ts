import { PartialType } from '@nestjs/swagger';
import { CreateShiftJobDto } from './create-shift-job.dto';

export class UpdateShiftJobDto extends PartialType(CreateShiftJobDto) {}
