import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AdminAuditLog,
  Category,
  Event,
  MenuImport,
  Organization,
  PfandType,
  Product,
  UserOrganization,
} from '../../database/entities';
import { AiModule } from '../ai/ai.module';
import { GatewayModule } from '../gateway/gateway.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { IconSuggestionService } from './icon-suggestion.service';
import { MenuImportController } from './menu-import/menu-import.controller';
import { MenuImportService } from './menu-import/menu-import.service';
import { MenuImportWorkerService } from './menu-import/menu-import-worker.service';

/**
 * Assistent-Funktionen (ki-plan.md Phase 1): Opt-in je Organisation,
 * Speisekarten-Import, Icon-Vorschlaege. Den Modellanbieter und die
 * Kontingente liefert AiModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Organization,
      UserOrganization,
      Event,
      Category,
      Product,
      PfandType,
      MenuImport,
      AdminAuditLog,
    ]),
    AiModule,
    GatewayModule,
    OrganizationsModule,
  ],
  controllers: [AssistantController, MenuImportController],
  providers: [
    AssistantService,
    IconSuggestionService,
    MenuImportService,
    MenuImportWorkerService,
  ],
  exports: [AssistantService, IconSuggestionService],
})
export class AssistantModule {}
