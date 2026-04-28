import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { Printer, Device, UserOrganization } from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Printer, Device, UserOrganization]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [PrintersController],
  providers: [PrintersService],
  exports: [PrintersService],
})
export class PrintersModule {}
