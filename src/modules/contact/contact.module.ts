import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContactRequest } from '../../database/entities';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { SupportModule } from '../support';

@Module({
  imports: [TypeOrmModule.forFeature([ContactRequest]), SupportModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
