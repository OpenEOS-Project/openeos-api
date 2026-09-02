import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TseController } from './tse.controller';
import { TseService } from './tse.service';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { NullTseProvider } from './providers/null-tse.provider';
import { Organization, Device, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Organization, Device, UserOrganization])],
  controllers: [TseController],
  providers: [TseService, FiskalyTseProvider, NullTseProvider],
  exports: [TseService],
})
export class TseModule {}
