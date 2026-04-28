import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SumUpController } from './sumup.controller';
import { SumUpService } from './sumup.service';
import { SumUpApiService } from './sumup-api.service';
import { Organization, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Organization, UserOrganization])],
  controllers: [SumUpController],
  providers: [SumUpService, SumUpApiService],
  exports: [SumUpService, SumUpApiService],
})
export class SumUpModule {}
