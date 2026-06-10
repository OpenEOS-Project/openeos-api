import { Module, forwardRef } from '@nestjs/common';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([PfandType, PfandReturn, UserOrganization]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [PfandTypesController],
  providers: [PfandTypesService, PfandReturnsService],
  exports: [PfandTypesService, PfandReturnsService],
})
export class PfandTypesModule {}
