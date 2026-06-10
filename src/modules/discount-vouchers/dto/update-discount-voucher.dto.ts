import { PartialType } from '@nestjs/swagger';
import { CreateDiscountVoucherDto } from './create-discount-voucher.dto';

export class UpdateDiscountVoucherDto extends PartialType(
  CreateDiscountVoucherDto,
) {}
