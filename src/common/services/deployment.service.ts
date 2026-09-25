import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { DeploymentMode } from '../../config/configuration';

/**
 * Beantwortet die Frage "in welcher Betriebsart laeuft diese Installation?".
 *
 * Bis hierher war das nur implizit beantwortbar: der Setup-Assistent kannte
 * zwar 'single' und 'multi', hat die Wahl aber nirgends festgehalten — nichts
 * im System konnte danach noch fragen. Die Betriebsart kommt deshalb aus der
 * Umgebung und nicht aus der Datenbank: ein Wert in der Datenbank waere von
 * jedem aenderbar, der die Admin-Oberflaeche erreicht.
 */
@Injectable()
export class DeploymentService {
  private readonly logger = new Logger(DeploymentService.name);

  readonly mode: DeploymentMode;

  /** Kostenpflichtige Freischaltung von Veranstaltungen aktiv? */
  readonly billingEnabled: boolean;

  /** Duerfen mehrere Organisationen nebeneinander existieren? */
  readonly multiTenant: boolean;

  constructor(private readonly configService: ConfigService) {
    this.mode = this.configService.get<DeploymentMode>('deployment.mode') ?? 'saas';
    this.billingEnabled = this.configService.get<boolean>('deployment.billingEnabled') ?? true;
    this.multiTenant = this.configService.get<boolean>('deployment.multiTenant') ?? true;

    if (this.isSelfHosted) {
      this.logger.log(
        'Betriebsart: selfhosted — Abrechnung deaktiviert, genau eine Organisation.',
      );
    }
  }

  get isSelfHosted(): boolean {
    return this.mode === 'selfhosted';
  }
}
