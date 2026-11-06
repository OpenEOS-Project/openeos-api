import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';

import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import type { AppRequest } from '../types/request.types';
import {
  OrganizationClosureService,
  type OrganizationClosure,
} from './organization-closure.service';

export const CLOSED_ORGANIZATION_ACCESS_KEY = 'closedOrganizationAccess';

/**
 * Schreibender Endpunkt, der auch in einer geloeschten Organisation
 * erlaubt bleibt, weil er nur dem Export dient (z. B. TSE-Export abholen,
 * Kassenabschluss fuer den DSFinV-K-Export erstellen).
 */
export const ClosedOrganizationAccess = () =>
  SetMetadata(CLOSED_ORGANIZATION_ACCESS_KEY, true);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Controller, deren Pfade keine Organisation des Vereins ansprechen. */
const UNSCOPED_PREFIXES = [
  'admin',
  'auth',
  'users',
  'health',
  'internal',
  'monitoring',
  'setup',
  'legal',
  'invitations',
  '.well-known',
];

function controllerPath(reflector: Reflector, context: ExecutionContext) {
  const raw = reflector.get<string | string[] | undefined>(
    PATH_METADATA,
    context.getClass(),
  );
  const path = Array.isArray(raw) ? raw[0] : raw;
  return (path ?? '').replace(/^\/+/, '');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Nur-lesen-Zugang fuer geloeschte bzw. geschlossene Organisationen (AGB
 * 10.4 „nur noch lesend nutzbar“, AVV 10.2).
 *
 * Bis zur endgueltigen Loeschung bleiben die Mitgliedschaften bestehen.
 * Fuer Anfragen, die eine solche Organisation ansprechen (Pfad
 * `organizations/:id…`, `events/:eventId…`, `organizationId` in Rumpf oder
 * Query), gilt:
 *
 * - Administratoren (und Super-Admins) duerfen lesen und exportieren, aber
 *   nichts aendern: jede andere Methode als GET/HEAD/OPTIONS endet mit 403
 *   `ORGANIZATION_READ_ONLY`, ausser an Endpunkten mit
 *   `@ClosedOrganizationAccess()`.
 * - Andere Mitglieder haben keinen Zugriff mehr (403 `ORGANIZATION_CLOSED`).
 * - Oeffentliche Seiten (Shop, Bestellung am Tisch) antworten mit 404.
 *
 * Laeuft als globaler Guard nach der Anmeldung; Geraete und API-Tokens
 * werden zusaetzlich an ihrer eigenen Pruefung abgewiesen.
 */
@Injectable()
export class OrganizationClosureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly closures: OrganizationClosureService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const path = controllerPath(this.reflector, context);
    if (
      UNSCOPED_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      )
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AppRequest>();
    const isPublic = path.startsWith('public/') || path === 'public';
    const organizationIds = await this.targetOrganizations(
      request,
      path,
      isPublic,
    );
    if (organizationIds.length === 0) return true;

    const closures = await this.closures.closures(organizationIds);
    if (closures.size === 0) return true;

    if (isPublic || !request.user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_CLOSED,
        message: 'Diese Organisation gibt es nicht mehr.',
      });
    }

    const allowWrite =
      this.reflector.getAllAndOverride<boolean>(
        CLOSED_ORGANIZATION_ACCESS_KEY,
        [context.getHandler(), context.getClass()],
      ) === true;

    for (const [organizationId, closure] of closures) {
      this.check(request, organizationId, closure, allowWrite);
    }
    return true;
  }

  private check(
    request: AppRequest,
    organizationId: string,
    closure: OrganizationClosure,
    allowWrite: boolean,
  ): void {
    const user = request.user!;
    if (!user.isSuperAdmin) {
      const membership = user.organizations?.find(
        (o) => o.id === organizationId,
      );
      // Kein Mitglied: die eigentliche Pruefung am Endpunkt lehnt ab.
      if (!membership) return;
      if (membership.role !== 'admin' || closure.purged) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.ORGANIZATION_CLOSED,
          message:
            'Diese Organisation wurde gelöscht. Nur Administratoren können ihre Daten bis zur endgültigen Löschung noch exportieren.',
        });
      }
    }
    if (READ_METHODS.has(request.method.toUpperCase()) || allowWrite) return;
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.ORGANIZATION_READ_ONLY,
      message:
        'Diese Organisation wird gelöscht und ist nur noch lesend nutzbar. Du kannst ihre Daten bis zur endgültigen Löschung exportieren.',
      params: { finalDeletionAt: closure.finalDeletionAt.toISOString() },
    });
  }

  /** Organisationen, die die Anfrage anspricht. */
  private async targetOrganizations(
    request: AppRequest,
    path: string,
    isPublic: boolean,
  ): Promise<string[]> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const ids = new Set<string>();
    const add = (value: unknown) => {
      const id = str(value);
      if (id) ids.add(id);
    };

    add(params.organizationId);
    if (path === 'organizations' || path.startsWith('organizations/')) {
      add(params.id);
    }
    if (!isPublic) {
      const body = request.body as Record<string, unknown> | undefined;
      if (body && typeof body === 'object') add(body.organizationId);
      add(
        (request.query as Record<string, unknown> | undefined)?.organizationId,
      );
    }
    const eventId = str(params.eventId);
    if (eventId) {
      add(await this.closures.organizationOfEvent(eventId));
    }
    return [...ids];
  }
}
