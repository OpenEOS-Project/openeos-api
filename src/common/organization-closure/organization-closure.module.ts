import { Global, Module } from '@nestjs/common';

import { OrganizationClosureService } from './organization-closure.service';

/**
 * Loeschzustand von Organisationen (Nur-lesen-Zugang bis zur endgueltigen
 * Loeschung). Global, weil Guard, Organisationsansicht, Geraete- und
 * Token-Pruefung ihn brauchen.
 */
@Global()
@Module({
  providers: [OrganizationClosureService],
  exports: [OrganizationClosureService],
})
export class OrganizationClosureModule {}
