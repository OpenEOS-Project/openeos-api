import { Global, Module } from '@nestjs/common';

import { DeploymentService } from './services/deployment.service';

/**
 * Global verfuegbare Querschnittsdienste.
 *
 * `DeploymentService` wird von Guards, Setup, Events und Organisationen
 * gebraucht — ihn in jedes dieser Module einzeln einzutragen waere eine
 * Liste, die bei jedem neuen Aufrufer nachgepflegt werden muesste. Wie
 * `ConfigModule` (isGlobal) ist er deshalb global.
 */
@Global()
@Module({
  providers: [DeploymentService],
  exports: [DeploymentService],
})
export class CommonModule {}
