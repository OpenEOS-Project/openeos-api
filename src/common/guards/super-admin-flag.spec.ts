import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Role } from '../constants/roles.enum';
import { OrganizationGuard } from './organization.guard';
import { RolesGuard } from './roles.guard';
import { SuperAdminGuard } from './super-admin.guard';

/**
 * Alle drei Guards muessen das Super-Admin-Kennzeichen am selben Feld
 * erkennen.
 *
 * Frueher las der SuperAdminGuard `isSuperAdmin`, Organisations- und
 * Rollen-Guard dagegen `isSuperadmin` (kleines a). Das hielt nur, weil die
 * JWT-Strategie zufaellig beide Felder setzte; der API-Token-Pfad setzte
 * nur eines. Diese Tests binden die Guards an denselben Namen — wer eine
 * Schreibweise aendert, sieht es hier und nicht erst in der Rechteverwaltung.
 */
function contextFor(
  user: unknown,
  params: Record<string, string> = {},
): ExecutionContext {
  const request = { user, params, headers: {}, body: {}, query: {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('Super-Admin-Kennzeichen', () => {
  // Genau die Form, die die Entity liefert — ohne Alias.
  const superAdmin = {
    id: 'u1',
    email: 'admin@example.org',
    isSuperAdmin: true,
    organizations: [],
  };
  const member = {
    id: 'u2',
    email: 'member@example.org',
    isSuperAdmin: false,
    organizations: [],
  };
  const fremdeOrganisation = { organizationId: 'org-ohne-mitgliedschaft' };

  it('SuperAdminGuard erkennt isSuperAdmin', () => {
    expect(new SuperAdminGuard().canActivate(contextFor(superAdmin))).toBe(
      true,
    );
    expect(() => new SuperAdminGuard().canActivate(contextFor(member))).toThrow(
      ForbiddenException,
    );
  });

  it('OrganizationGuard erkennt dasselbe Feld', () => {
    const guard = new OrganizationGuard();
    expect(guard.canActivate(contextFor(superAdmin, fremdeOrganisation))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor(member, fremdeOrganisation)),
    ).toThrow(ForbiddenException);
  });

  it('RolesGuard erkennt dasselbe Feld', () => {
    const reflector = {
      getAllAndOverride: () => [Role.ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(contextFor(superAdmin, fremdeOrganisation))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor(member, fremdeOrganisation)),
    ).toThrow(ForbiddenException);
  });

  it('ein Alias in Kleinschreibung zaehlt nicht mehr', () => {
    // Genau die alte Form: nur `isSuperadmin`. Kein Guard darf darauf
    // reagieren, sonst gaebe es wieder zwei Wahrheiten.
    const nurAlias = { ...member, isSuperadmin: true };
    expect(() =>
      new SuperAdminGuard().canActivate(contextFor(nurAlias)),
    ).toThrow(ForbiddenException);
    expect(() =>
      new OrganizationGuard().canActivate(
        contextFor(nurAlias, fremdeOrganisation),
      ),
    ).toThrow(ForbiddenException);
  });
});
