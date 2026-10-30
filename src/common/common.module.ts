import { Global, Module } from '@nestjs/common';

import { DeploymentService } from './services/deployment.service';
import { OrganizationLimitsService } from './services/organization-limits.service';
import { ShutdownService } from './lifecycle/shutdown.service';

/**
 * Global verfuegbare Querschnittsdienste.
 *
 * `DeploymentService` wird von Guards, Setup, Events und Organisationen
 * gebraucht — ihn in jedes dieser Module einzeln einzutragen waere eine
 * Liste, die bei jedem neuen Aufrufer nachgepflegt werden muesste. Wie
 * `ConfigModule` (isGlobal) ist er deshalb global.
 *
 * `ShutdownService` haelt fest, ob die Instanz gerade herunterfaehrt —
 * die Readiness-Pruefung fragt ihn, main.ts schaltet die Hooks ein.
 *
 * `OrganizationLimitsService` (Organisationen je Benutzer, Mitglieder je
 * Organisation) brauchen Organisationen, Auth, Setup und Admin — aus
 * demselben Grund global.
 */
@Global()
@Module({
  providers: [DeploymentService, ShutdownService, OrganizationLimitsService],
  exports: [DeploymentService, ShutdownService, OrganizationLimitsService],
})
export class CommonModule {}
