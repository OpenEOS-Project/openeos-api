import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContactRequest } from '../../database/entities';
import { ContactController } from './contact.controller';
import { ContactAdminController } from './contact-admin.controller';
import { ContactAdminService } from './contact-admin.service';
import { ContactService } from './contact.service';

@Module({
  imports: [TypeOrmModule.forFeature([ContactRequest])],
  controllers: [ContactController, ContactAdminController],
  providers: [ContactService, ContactAdminService],
})
export class ContactModule {}
