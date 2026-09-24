import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { ApiToken, User } from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';
import type { ApiScope } from './api-scopes';

/** Am Anfang jedes Tokens, damit man ihn in einem Protokoll erkennt. */
const PRAEFIX = 'oeos_';

/**
 * Wie lange ein benutzter Token nicht erneut vermerkt wird.
 *
 * Ohne diese Bremse schriebe eine Überwachung, die im Minutentakt fragt,
 * bei jeder Anfrage in dieselbe Zeile. Für die Frage „wird dieser Token
 * noch verwendet?" genügt Minutengenauigkeit bei Weitem.
 */
const BENUTZT_VERMERK_INTERVALL_MS = 5 * 60 * 1000;

export interface TokenPruefung {
  user: User;
  scopes: string[];
}

@Injectable()
export class ApiTokensService {
  private readonly logger = new Logger(ApiTokensService.name);

  constructor(
    @InjectRepository(ApiToken)
    private readonly apiTokenRepository: Repository<ApiToken>,
  ) {}

  /** Nur der Hash wird gespeichert — hier wird er gebildet. */
  private hash(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Einen Token ausstellen.
   *
   * Der Klartext wird genau hier einmal zurückgegeben und danach
   * vergessen. Wer ihn verliert, stellt einen neuen aus.
   */
  async erstelle(options: {
    userId: string;
    name: string;
    scopes: ApiScope[];
    expiresAt?: Date | null;
  }): Promise<{ token: string; eintrag: ApiToken }> {
    const geheim = `${PRAEFIX}${crypto.randomBytes(32).toString('base64url')}`;

    const eintrag = await this.apiTokenRepository.save(
      this.apiTokenRepository.create({
        name: options.name,
        tokenHash: this.hash(geheim),
        tokenPrefix: geheim.slice(0, 12),
        userId: options.userId,
        scopes: options.scopes,
        expiresAt: options.expiresAt ?? null,
      }),
    );

    this.logger.log(`API-Token ausgestellt: ${eintrag.name} (${eintrag.tokenPrefix}…)`);

    return { token: geheim, eintrag };
  }

  /** Sieht der Wert überhaupt nach einem API-Token aus? */
  static istApiToken(wert: string | undefined): boolean {
    return !!wert && wert.startsWith(PRAEFIX);
  }

  /**
   * Token prüfen und den Besitzer zurückgeben.
   *
   * `null` bei allem, was nicht stimmt — die Unterscheidung zwischen
   * „gibt es nicht", „widerrufen" und „abgelaufen" bleibt drinnen: nach
   * außen ist jeder dieser Fälle schlicht nicht angemeldet.
   */
  async pruefe(token: string): Promise<TokenPruefung | null> {
    const eintrag = await this.apiTokenRepository.findOne({
      where: { tokenHash: this.hash(token) },
      relations: ['user'],
    });

    if (!eintrag) return null;
    if (eintrag.revokedAt) return null;
    if (eintrag.expiresAt && eintrag.expiresAt < new Date()) return null;
    if (!eintrag.user?.isActive) return null;

    void this.vermerkeBenutzung(eintrag);

    return { user: eintrag.user, scopes: eintrag.scopes ?? [] };
  }

  /* Nebenher und bewusst ohne await: ein fehlgeschlagener Vermerk darf
     keine Anfrage scheitern lassen. */
  private async vermerkeBenutzung(eintrag: ApiToken): Promise<void> {
    const zuletzt = eintrag.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - zuletzt < BENUTZT_VERMERK_INTERVALL_MS) return;

    try {
      await this.apiTokenRepository.update({ id: eintrag.id }, { lastUsedAt: new Date() });
    } catch (fehler) {
      this.logger.warn(`Benutzung nicht vermerkt (${eintrag.tokenPrefix}…): ${(fehler as Error).message}`);
    }
  }

  async liste(userId: string): Promise<ApiToken[]> {
    return this.apiTokenRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Widerrufen statt löschen: die Spur, dass es ihn gab, bleibt. */
  async widerrufe(userId: string, id: string): Promise<ApiToken> {
    const eintrag = await this.apiTokenRepository.findOne({ where: { id, userId } });
    if (!eintrag) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Token nicht gefunden',
      });
    }

    eintrag.revokedAt = eintrag.revokedAt ?? new Date();
    return this.apiTokenRepository.save(eintrag);
  }
}
