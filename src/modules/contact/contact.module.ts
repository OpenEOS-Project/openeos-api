import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { SupportModule } from '../support';

@Module({
  imports: [SupportModule],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
