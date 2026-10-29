import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import * as crypto from 'crypto';

import {
  AdminAction,
  AdminAuditLog,
  ApiToken,
  Event,
  User,
  UserOrganization,
} from '../../database/entities';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  ORGANIZATION_TOKEN_SCOPES,
  PLATFORM_TOKEN_SCOPES,
  TokenScope,
} from './api-scopes';

/** Am Anfang jedes Tokens, damit man ihn in einem Protokoll erkennt. */
export const TOKEN_PREFIX = 'oeos_';

/** So viele Zeichen des Klartexts bleiben zur Wiedererkennung gespeichert. */
const SICHTBARE_ZEICHEN = 12;

/**
 * Wie lange ein benutzter Token nicht erneut vermerkt wird.
 *
 * Ohne diese Bremse schriebe ein Agent, der im Sekundentakt fragt, bei
 * jeder Anfrage in dieselbe Zeile. Für die Frage „wird dieser Token noch
 * verwendet?" genügt Minutengenauigkeit.
 */
export const LAST_USED_INTERVAL_MS = 60 * 1000;

/** Mehr aktive Tokens braucht keine Organisation — und weniger Tokens lassen sich überblicken. */
export const MAX_ACTIVE_TOKENS_PER_ORGANIZATION = 20;

/** Ein Token, wie ihn die Oberfläche sehen darf. */
export type PublicApiToken = Omit<
  ApiToken,
  'tokenHash' | 'user' | 'organization'
> & {
  createdBy?: { id: string; firstName: string; lastName: string } | null;
};

/** @deprecated Alter Name von PublicApiToken. */
export type OeffentlicherApiToken = PublicApiToken;

export function oeffentlich(eintrag: ApiToken): PublicApiToken {
  const {
    tokenHash: _hash,
    user,
    organization: _organization,
    ...rest
  } = eintrag;
  return {
    ...rest,
    createdBy: user
      ? { id: user.id, firstName: user.firstName, lastName: user.lastName }
      : null,
  };
}

export interface TokenPruefung {
  user: User;
  scopes: string[];
  token: { id: string; name: string; organizationId: string | null };
  /** Mitgliedschaft des Besitzers in der Token-Organisation (null bei Plattform-Tokens). */
  membership: UserOrganization | null;
}

export interface AuditClient {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name);

  constructor(
    @InjectRepository(ApiToken)
    private readonly apiTokenRepository: Repository<ApiToken>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
  ) {}

  /**
   * Einen Token ausstellen.
   *
   * Der Klartext wird genau hier einmal zurückgegeben und danach
   * vergessen. Wer ihn verliert, stellt einen neuen aus.
   *
   * Mit `organizationId` entsteht ein Organisations-Token (nur
   * Organisations-Scopes, höchstens 20 aktive je Organisation), ohne ein
   * Plattform-Token (nur `monitoring:read`, Super-Admin).
   */
  async erstelle(options: {
    userId: string;
    organizationId?: string | null;
    name: string;
    scopes: TokenScope[];
    expiresAt?: Date | null;
    client?: AuditClient;
  }): Promise<{ token: string; eintrag: PublicApiToken }> {
    const organizationId = options.organizationId ?? null;
    const scopes = this.pruefeScopes(options.scopes, organizationId);

    if (options.expiresAt && options.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.API_TOKEN_EXPIRES_IN_PAST,
        message: 'Das Ablaufdatum muss in der Zukunft liegen',
      });
    }

    if (organizationId) {
      const aktive = await this.zaehleAktive(organizationId);
      if (aktive >= MAX_ACTIVE_TOKENS_PER_ORGANIZATION) {
        throw new ConflictException({
          code: ErrorCodes.CONFLICT,
          reason: ErrorReasons.API_TOKEN_LIMIT_REACHED,
          message: `Höchstens ${MAX_ACTIVE_TOKENS_PER_ORGANIZATION} aktive API-Tokens je Organisation`,
          params: { limit: MAX_ACTIVE_TOKENS_PER_ORGANIZATION },
        });
      }
    }

    const geheim = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;

    const eintrag = await this.apiTokenRepository.save(
      this.apiTokenRepository.create({
        name: options.name,
        tokenHash: hashToken(geheim),
        tokenPrefix: geheim.slice(0, SICHTBARE_ZEICHEN),
        userId: options.userId,
        organizationId,
        scopes,
        expiresAt: options.expiresAt ?? null,
      }),
    );

    this.logger.log(
      `API-Token ausgestellt: ${eintrag.name} (${eintrag.tokenPrefix}…)`,
    );

    if (organizationId) {
      await this.audit(AdminAction.API_TOKEN_CREATED, eintrag, options.client);
    }

    return { token: geheim, eintrag: oeffentlich(eintrag) };
  }

  /** Sieht der Wert überhaupt nach einem API-Token aus? */
  static istApiToken(wert: string | undefined): boolean {
    return !!wert && wert.startsWith(TOKEN_PREFIX);
  }

  /**
   * Token prüfen und den Besitzer zurückgeben.
   *
   * `null` bei allem, was nicht stimmt — die Unterscheidung zwischen
   * „gibt es nicht", „widerrufen", „abgelaufen" und „nicht mehr Mitglied"
   * bleibt drinnen: nach außen ist jeder dieser Fälle schlicht nicht
   * angemeldet.
   */
  async pruefe(token: string): Promise<TokenPruefung | null> {
    const eintrag = await this.apiTokenRepository.findOne({
      where: { tokenHash: hashToken(token) },
      relations: ['user'],
    });

    if (!eintrag) return null;
    if (eintrag.revokedAt) return null;
    if (eintrag.expiresAt && eintrag.expiresAt < new Date()) return null;
    if (!eintrag.user?.isActive) return null;

    let membership: UserOrganization | null = null;
    if (eintrag.organizationId) {
      /* Wer die Organisation verlassen hat (oder hinausgeworfen wurde),
         nimmt seine Tokens mit — sie laufen ins Leere. */
      membership = await this.userOrganizationRepository.findOne({
        where: {
          userId: eintrag.userId,
          organizationId: eintrag.organizationId,
        },
      });
      if (!membership) return null;
    } else if (!eintrag.user.isSuperAdmin) {
      return null;
    }

    void this.vermerkeBenutzung(eintrag);

    return {
      user: eintrag.user,
      scopes: eintrag.scopes ?? [],
      token: {
        id: eintrag.id,
        name: eintrag.name,
        organizationId: eintrag.organizationId ?? null,
      },
      membership,
    };
  }

  /**
   * Zu welcher Organisation eine Veranstaltung gehört — für Endpunkte
   * unter `events/:eventId/…`, die die Organisation nicht im Pfad tragen.
   */
  async organizationOfEvent(eventId: string): Promise<string | null> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
      select: ['id', 'organizationId'],
    });
    return event?.organizationId ?? null;
  }

  /* Nebenher und bewusst ohne await: ein fehlgeschlagener Vermerk darf
     keine Anfrage scheitern lassen. */
  private async vermerkeBenutzung(eintrag: ApiToken): Promise<void> {
    const zuletzt = eintrag.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - zuletzt < LAST_USED_INTERVAL_MS) return;

    try {
      await this.apiTokenRepository.update(
        { id: eintrag.id },
        { lastUsedAt: new Date() },
      );
    } catch (fehler) {
      this.logger.warn(
        `Benutzung nicht vermerkt (${eintrag.tokenPrefix}…): ${(fehler as Error).message}`,
      );
    }
  }

  /**
   * Die eigenen Plattform-Tokens — ohne den Hash.
   *
   * Mit ihm liesse sich zwar nichts anmelden, er ist aber das Material,
   * gegen das geprueft wird, und gehoert damit so wenig in eine Antwort
   * wie ein Passwort-Hash.
   */
  async liste(userId: string): Promise<PublicApiToken[]> {
    const eintraege = await this.apiTokenRepository.find({
      where: { userId, organizationId: IsNull() },
      order: { createdAt: 'DESC' },
    });

    return eintraege.map(oeffentlich);
  }

  /** Alle Tokens einer Organisation, egal wer sie ausgestellt hat. */
  async listeOrganisation(organizationId: string): Promise<PublicApiToken[]> {
    const eintraege = await this.apiTokenRepository.find({
      where: { organizationId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
    });

    return eintraege.map(oeffentlich);
  }

  /** Widerrufen statt löschen: die Spur, dass es ihn gab, bleibt. */
  async widerrufe(userId: string, id: string): Promise<PublicApiToken> {
    const eintrag = await this.apiTokenRepository.findOne({
      where: { id, userId, organizationId: IsNull() },
    });
    if (!eintrag) throw this.nichtGefunden();

    eintrag.revokedAt = eintrag.revokedAt ?? new Date();
    return oeffentlich(await this.apiTokenRepository.save(eintrag));
  }

  /**
   * Einen Organisations-Token widerrufen — jeder Admin der Organisation
   * darf das, nicht nur, wer ihn ausgestellt hat.
   */
  async widerrufeOrganisation(
    organizationId: string,
    id: string,
    actor: User,
    client?: AuditClient,
  ): Promise<PublicApiToken> {
    const eintrag = await this.apiTokenRepository.findOne({
      where: { id, organizationId },
      relations: ['user'],
    });
    if (!eintrag) throw this.nichtGefunden();

    if (!eintrag.revokedAt) {
      eintrag.revokedAt = new Date();
      await this.apiTokenRepository.save(eintrag);
      await this.audit(AdminAction.API_TOKEN_REVOKED, eintrag, client, actor);
    }
    return oeffentlich(eintrag);
  }

  private async zaehleAktive(organizationId: string): Promise<number> {
    const now = new Date();
    return this.apiTokenRepository.count({
      where: [
        { organizationId, revokedAt: IsNull(), expiresAt: IsNull() },
        { organizationId, revokedAt: IsNull(), expiresAt: MoreThan(now) },
      ],
    });
  }

  private pruefeScopes(
    scopes: TokenScope[],
    organizationId: string | null,
  ): TokenScope[] {
    const erlaubt = organizationId
      ? ORGANIZATION_TOKEN_SCOPES
      : PLATFORM_TOKEN_SCOPES;
    const eindeutig = [...new Set(scopes)];
    const fremd = eindeutig.filter((s) => !erlaubt.includes(s));
    if (eindeutig.length === 0 || fremd.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.API_TOKEN_SCOPE_INVALID,
        message: fremd.length
          ? `Scope nicht erlaubt: ${fremd.join(', ')}`
          : 'Mindestens ein Scope ist nötig',
        params: { scopes: fremd.join(', ') },
      });
    }
    return eindeutig;
  }

  private nichtGefunden(): NotFoundException {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.API_TOKEN_NOT_FOUND,
      message: 'Token nicht gefunden',
    });
  }

  private async audit(
    action: AdminAction,
    eintrag: ApiToken,
    client: AuditClient = {},
    actor?: User,
  ): Promise<void> {
    try {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          adminUserId: actor?.id ?? eintrag.userId,
          organizationId: eintrag.organizationId,
          action,
          resourceType: 'api_token',
          resourceId: eintrag.id,
          details: {
            name: eintrag.name,
            tokenPrefix: eintrag.tokenPrefix,
            scopes: eintrag.scopes,
            expiresAt: eintrag.expiresAt?.toISOString() ?? null,
            ownerUserId: eintrag.userId,
          },
          ipAddress: (client.ipAddress || 'unknown').slice(0, 45),
          userAgent: client.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      // Best effort: ein fehlender Protokolleintrag dreht die Aktion nicht zurueck.
      this.logger.error(
        `Protokolleintrag ${action} nicht geschrieben: ${(error as Error).message}`,
      );
    }
  }
}
