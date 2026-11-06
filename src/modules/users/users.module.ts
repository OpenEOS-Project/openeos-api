import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import {
  NewsletterController,
  NewsletterPublicController,
} from './newsletter.controller';
import { NewsletterService } from './newsletter.service';
import { User, RefreshToken } from '../../database/entities';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [TypeOrmModule.forFeature([User, RefreshToken]), UploadsModule],
  controllers: [
    UsersController,
    NewsletterController,
    NewsletterPublicController,
  ],
  providers: [UsersService, NewsletterService],
  exports: [UsersService, NewsletterService],
})
export class UsersModule {}
