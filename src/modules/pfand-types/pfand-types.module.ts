import { Module, forwardRef } from '@nestjs/common';
import { TseModule } from '../tse/tse.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PfandTypesController } from './pfand-types.controller';
import { PfandTypesService } from './pfand-types.service';
import { PfandReturnsService } from './pfand-returns.service';
import {
  PfandType,
  PfandReturn,
  UserOrganization,
} from '../../database/entities';
import { GatewayModule } from '../gateway/gateway.module';
import { PrintJobsModule } from '../print-jobs/print-jobs.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PfandType, PfandReturn, UserOrganization]),
    forwardRef(() => GatewayModule),
    forwardRef(() => PrintJobsModule),
    TseModule,
  ],
  controllers: [PfandTypesController],
  providers: [PfandTypesService, PfandReturnsService],
  exports: [PfandTypesService, PfandReturnsService],
})
export class PfandTypesModule {}
