import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { PrinterAgentsController } from './printer-agents.controller';
import { PrinterAgentsService } from './printer-agents.service';
import {
  Printer,
  Device,
  DiscoveredPrinter,
  Organization,
  ProductionStation,
  UserOrganization,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Printer,
      Device,
      DiscoveredPrinter,
      Organization,
      ProductionStation,
      UserOrganization,
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [PrintersController, PrinterAgentsController],
  providers: [PrintersService, PrinterAgentsService],
  exports: [PrintersService, PrinterAgentsService],
})
export class PrintersModule {}
