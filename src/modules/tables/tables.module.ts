import { Module, forwardRef } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/** Tische und Bereiche; der Service arbeitet direkt mit der DataSource. */
@Module({
  imports: [forwardRef(() => GatewayModule)],
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
