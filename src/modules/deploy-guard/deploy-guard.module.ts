import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Order } from '../../database/entities';
import { DeployGuardController } from './deploy-guard.controller';
import { DeployGuardService } from './deploy-guard.service';
import { DeployGuardTokenGuard } from './deploy-guard-token.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Order])],
  controllers: [DeployGuardController],
  providers: [DeployGuardService, DeployGuardTokenGuard],
})
export class DeployGuardModule {}
