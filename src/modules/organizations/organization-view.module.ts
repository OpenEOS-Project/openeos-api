import { Module } from '@nestjs/common';

import { TseModule } from '../tse/tse.module';
import { OrganizationViewService } from './organization-view.service';

/**
 * Eigenes Modul, damit Anmeldung und Kasse die Organisations-Antwort bauen
 * koennen, ohne das ganze Organisationsmodul (und dessen Abhaengigkeiten)
 * zu importieren. Haengt nur an der TSE, die selbst keine Fachmodule
 * importiert.
 */
@Module({
  imports: [TseModule],
  providers: [OrganizationViewService],
  exports: [OrganizationViewService],
})
export class OrganizationViewModule {}
