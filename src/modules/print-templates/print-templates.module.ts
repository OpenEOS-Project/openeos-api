import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrintTemplatesController } from './print-templates.controller';
import { PrintTemplatesService } from './print-templates.service';
import { PrintTemplate, UserOrganization } from '../../database/entities';

@Module({
  imports: [TypeOrmModule.forFeature([PrintTemplate, UserOrganization])],
  controllers: [PrintTemplatesController],
  providers: [PrintTemplatesService],
  exports: [PrintTemplatesService],
})
export class PrintTemplatesModule {}
