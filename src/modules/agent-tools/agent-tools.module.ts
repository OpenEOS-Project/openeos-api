import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AdminAuditLog } from '../../database/entities';
import { AssistantModule } from '../assistant';
import { CategoriesModule } from '../categories';
import { DevicesModule } from '../devices';
import { EventsModule } from '../events';
import { GatewayModule } from '../gateway';
import { OrdersModule } from '../orders';
import { OrganizationsModule } from '../organizations';
import { PfandTypesModule } from '../pfand-types';
import { PrintTemplatesModule } from '../print-templates';
import { PrintersModule } from '../printers';
import { ProductionStationsModule } from '../production-stations/production-stations.module';
import { ProductsModule } from '../products';
import { ReportsModule } from '../reports';
import { ShiftsModule } from '../shifts';
import { TablesModule } from '../tables';
import { AgentAuditService } from './agent-audit.service';
import { AgentToolsRegistry } from './agent-tools.registry';
import {
  CatalogTools,
  DeviceTools,
  EventTools,
  IconTools,
  OrganizationTools,
  ReportTools,
  StaffTools,
  TableTools,
} from './tools';

/**
 * Werkzeuge fuer Agenten (ki-plan.md Abschnitt 2.5 und 9).
 *
 * Ein Werkzeug-Layer, viele Zugaenge: der MCP-Server nutzt die Registry,
 * spaeter auch der Assistent in der App. Die Handler rufen die Dienste
 * der Fachmodule direkt — keine HTTP-Umwege, dieselben Rechtepruefungen.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AdminAuditLog]),
    OrganizationsModule,
    GatewayModule,
    EventsModule,
    CategoriesModule,
    ProductsModule,
    PfandTypesModule,
    ProductionStationsModule,
    TablesModule,
    ShiftsModule,
    PrintTemplatesModule,
    PrintersModule,
    DevicesModule,
    ReportsModule,
    OrdersModule,
    AssistantModule,
  ],
  providers: [
    AgentAuditService,
    AgentToolsRegistry,
    OrganizationTools,
    EventTools,
    CatalogTools,
    TableTools,
    StaffTools,
    DeviceTools,
    ReportTools,
    IconTools,
  ],
  exports: [AgentToolsRegistry],
})
export class AgentToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: AgentToolsRegistry,
    private readonly organization: OrganizationTools,
    private readonly events: EventTools,
    private readonly catalog: CatalogTools,
    private readonly tables: TableTools,
    private readonly staff: StaffTools,
    private readonly devices: DeviceTools,
    private readonly reports: ReportTools,
    private readonly icons: IconTools,
  ) {}

  onModuleInit(): void {
    this.registry.registerAll([
      ...this.organization.tools(),
      ...this.events.tools(),
      ...this.catalog.tools(),
      ...this.tables.tools(),
      ...this.staff.tools(),
      ...this.devices.tools(),
      ...this.reports.tools(),
      ...this.icons.tools(),
    ]);
  }
}
