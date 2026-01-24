import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { Product, UserOrganization, StockMovement, Event } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Product, UserOrganization, StockMovement, Event])],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
