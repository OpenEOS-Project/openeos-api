import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountVouchersController } from './discount-vouchers.controller';
import { DiscountVouchersService } from './discount-vouchers.service';
import { DiscountVoucher, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([DiscountVoucher, UserOrganization])],
  controllers: [DiscountVouchersController],
  providers: [DiscountVouchersService],
  exports: [DiscountVouchersService],
})
export class DiscountVouchersModule {}
