import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SAAS_ONLY_KEY } from '../decorators/saas-only.decorator';
import { DeploymentService } from '../services/deployment.service';

/**
 * Blendet die Endpunkte des gehosteten Angebots in einer eigenstaendigen
 * Installation aus.
 *
 * Global registriert, damit die Regel nicht an jedem Controller wiederholt
 * werden muss — markiert wird mit `@SaasOnly()`. Die Sperre sitzt bewusst
 * serverseitig: das Frontend blendet dieselben Bereiche zwar aus, aber
 * ausgeblendet ist nicht gesperrt.
 */
@Injectable()
export class DeploymentModeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly deployment: DeploymentService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.deployment.isSelfHosted) return true;

    const isSaasOnly = this.reflector.getAllAndOverride<boolean>(SAAS_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isSaasOnly) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Diese Funktion ist in einer eigenstaendigen Installation nicht verfuegbar',
      });
    }

    return true;
  }
}
