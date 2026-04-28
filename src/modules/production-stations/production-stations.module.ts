import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionStationsController } from './production-stations.controller';
import { ProductionStationsService } from './production-stations.service';
import { ProductionStation, UserOrganization, Event, Printer } from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProductionStation, UserOrganization, Event, Printer]),
  ],
  controllers: [ProductionStationsController],
  providers: [ProductionStationsService],
  exports: [ProductionStationsService],
})
export class ProductionStationsModule {}
