import { PartialType } from '@nestjs/swagger';
import { CreatePfandTypeDto } from './create-pfand-type.dto';

export class UpdatePfandTypeDto extends PartialType(CreatePfandTypeDto) {}
