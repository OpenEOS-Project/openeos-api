import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { Printer, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([Printer, UserOrganization])],
  controllers: [PrintersController],
  providers: [PrintersService],
  exports: [PrintersService],
})
export class PrintersModule {}
