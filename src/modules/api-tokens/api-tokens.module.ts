import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  AdminAuditLog,
  ApiToken,
  Event,
  UserOrganization,
} from '../../database/entities';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokensController } from './api-tokens.controller';
import { OrganizationApiTokensController } from './organization-api-tokens.controller';

/**
 * Global, weil der Dienst im globalen JwtAuthGuard steckt: der wird in
 * AppModule bereitgestellt und braucht ihn dort auflösbar.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApiToken,
      UserOrganization,
      Event,
      AdminAuditLog,
    ]),
  ],
  controllers: [ApiTokensController, OrganizationApiTokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
