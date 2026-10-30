import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull, MoreThan } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import { Invitation } from '../../database/entities/invitation.entity';
import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities/user.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';

/** 0 bedeutet "keine Schranke". */
export const UNLIMITED = 0;

export interface OrganizationUsage {
  /** Wirksame Obergrenze (eigener Wert oder Standard); 0 = unbegrenzt. */
  organizationLimit: number;
  /** Mitgliedschaften des Benutzers, unabhaengig von der Rolle. */
  organizationCount: number;
}

export interface MemberUsage {
  /** Wirksame Obergrenze (eigener Wert oder Standard); 0 = unbegrenzt. */
  memberLimit: number;
  /** Aktive Mitglieder plus offene, nicht abgelaufene Einladungen. */
  memberCount: number;
}

/**
 * Missbrauchsschranken: Organisationen je Benutzer und Mitglieder je
 * Organisation (Entscheidung 2026-10-30).
 *
 * Was zaehlt:
 * - Organisationen eines Benutzers = seine Zeilen in `user_organizations`,
 *   egal ob Admin oder Mitglied. Geprueft beim Anlegen einer Organisation
 *   und beim Annehmen einer Einladung.
 * - Plaetze einer Organisation = Zeilen in `user_organizations` plus
 *   Einladungen, die weder angenommen noch abgelaufen sind. Geprueft beim
 *   Einladen und beim direkten Hinzufuegen. Eine Einladung belegt ihren
 *   Platz also schon vor dem Annehmen; das Annehmen prueft ihn nicht erneut.
 * - Helfer (Schichtanmeldungen, Anmeldelinks) haben keine Mitgliedschaft
 *   und zaehlen nicht.
 *
 * Super-Admins sind ausgenommen: als Handelnde (sie legen an, laden ein,
 * nehmen an) greift keine Schranke. Fuer alle anderen gilt der Standard aus
 * der Umgebung, es sei denn, ein Super-Admin hat am Benutzer
 * (`organization_limit`) oder an der Organisation (`member_limit`) einen
 * eigenen Wert hinterlegt. 0 heisst in beiden Faellen unbegrenzt.
 *
 * Die Pruefungen laufen in der Transaktion des Aufrufers und sperren vorher
 * die Zeile des Benutzers bzw. der Organisation (`FOR UPDATE`), damit zwei
 * gleichzeitige Anfragen nicht beide noch "ein Platz frei" sehen. Schlaegt
 * das Zaehlen fehl, scheitert die Anfrage — nie still durchwinken.
 */
@Injectable()
export class OrganizationLimitsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  get defaultOrganizationLimit(): number {
    return normalize(
      this.configService.get<number>('limits.organizationsPerUser'),
      5,
    );
  }

  get defaultMemberLimit(): number {
    return normalize(
      this.configService.get<number>('limits.membersPerOrganization'),
      10,
    );
  }

  effectiveOrganizationLimit(
    user: Pick<User, 'organizationLimit'> | null | undefined,
  ): number {
    return user?.organizationLimit ?? this.defaultOrganizationLimit;
  }

  effectiveMemberLimit(
    organization: Pick<Organization, 'memberLimit'> | null | undefined,
  ): number {
    return organization?.memberLimit ?? this.defaultMemberLimit;
  }

  async countMemberships(
    userId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    return manager.count(UserOrganization, { where: { userId } });
  }

  async countMemberSeats(
    organizationId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    const [members, pending] = await Promise.all([
      manager.count(UserOrganization, { where: { organizationId } }),
      manager.count(Invitation, {
        where: {
          organizationId,
          acceptedAt: IsNull(),
          expiresAt: MoreThan(new Date()),
        },
      }),
    ]);
    return members + pending;
  }

  async organizationUsage(
    user: Pick<User, 'id' | 'organizationLimit'>,
    manager?: EntityManager,
  ): Promise<OrganizationUsage> {
    return {
      organizationLimit: this.effectiveOrganizationLimit(user),
      organizationCount: await this.countMemberships(user.id, manager),
    };
  }

  async memberUsage(
    organization: Pick<Organization, 'id' | 'memberLimit'>,
    manager?: EntityManager,
  ): Promise<MemberUsage> {
    return {
      memberLimit: this.effectiveMemberLimit(organization),
      memberCount: await this.countMemberSeats(organization.id, manager),
    };
  }

  /**
   * Darf der Benutzer einer weiteren Organisation beitreten (anlegen oder
   * Einladung annehmen)? Innerhalb der Transaktion aufrufen, bevor die
   * Mitgliedschaft geschrieben wird. Liest den eigenen Wert frisch aus der
   * gesperrten Zeile, nicht aus dem (moeglicherweise aelteren) Objekt des
   * Aufrufers.
   */
  async assertCanJoinOrganization(
    user: Pick<User, 'id' | 'isSuperAdmin'>,
    manager: EntityManager,
  ): Promise<void> {
    if (user.isSuperAdmin) return;

    const rows: { organization_limit: number | null }[] = await manager.query(
      'SELECT organization_limit FROM users WHERE id = $1 FOR UPDATE',
      [user.id],
    );
    const limit = this.effectiveOrganizationLimit({
      organizationLimit: rows[0]?.organization_limit ?? null,
    });
    if (limit === UNLIMITED) return;

    const used = await this.countMemberships(user.id, manager);
    if (used >= limit) {
      throw new ForbiddenException({
        code: ErrorCodes.ORGANIZATION_LIMIT_REACHED,
        reason: ErrorCodes.ORGANIZATION_LIMIT_REACHED,
        message: `Du kannst höchstens ${limit} Organisationen anlegen oder ihnen beitreten`,
        params: { limit, used },
      });
    }
  }

  /**
   * Hat die Organisation noch einen Platz frei (fuer eine Einladung oder
   * ein direkt hinzugefuegtes Mitglied)? `actor` ist, wer einlaedt bzw.
   * hinzufuegt. Innerhalb der Transaktion aufrufen, bevor geschrieben wird.
   */
  async assertMemberSeatAvailable(
    organizationId: string,
    actor: Pick<User, 'isSuperAdmin'>,
    manager: EntityManager,
  ): Promise<void> {
    if (actor.isSuperAdmin) return;

    const rows: { member_limit: number | null }[] = await manager.query(
      'SELECT member_limit FROM organizations WHERE id = $1 FOR UPDATE',
      [organizationId],
    );
    if (rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    const limit = this.effectiveMemberLimit({
      memberLimit: rows[0].member_limit ?? null,
    });
    if (limit === UNLIMITED) return;

    const used = await this.countMemberSeats(organizationId, manager);
    if (used >= limit) {
      throw new ForbiddenException({
        code: ErrorCodes.MEMBER_LIMIT_REACHED,
        reason: ErrorCodes.MEMBER_LIMIT_REACHED,
        message: `Diese Organisation hat die Höchstzahl von ${limit} Mitgliedern erreicht (inklusive offener Einladungen)`,
        params: { limit, used },
      });
    }
  }
}

function normalize(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}
