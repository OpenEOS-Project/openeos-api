import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { User } from '../../../database/entities';
import { gesperrterTokenSchluessel } from '../token-blocklist';

// Falls back to the httpOnly `accessToken` cookie set by AuthController when
// no Authorization header is present, so browser clients no longer need to
// keep the access token in localStorage to stay authenticated.
function extractFromCookie(req: Request): string | null {
  // cookie-parser typt die Cookies als Record<string, any>.
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.accessToken || null;
}

export interface JwtPayload {
  /** Eindeutig je ausgegebenem Token — trennt zwei gleichzeitige Sitzungen. */
  jti?: string;
  /** Gesetzt zwischen Passwort und zweitem Faktor — kein voller Zugang. */
  pending2fa?: boolean;
  sub: string;
  email: string;
  isSuperAdmin: boolean;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {
    const secret = configService.get<string>('jwt.secret');
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractFromCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
      /* Die Anfrage wird mitgereicht, weil die Sperrliste den Token
         selbst braucht — aus den Claims allein laesst er sich nicht
         rekonstruieren. */
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request,
    payload: JwtPayload,
  ): Promise<
    User & {
      organizations: { id: string; role: string }[];
    }
  > {
    /* Abgemeldete Token abweisen. Ohne diese Pruefung blieb ein Token nach
       dem Abmelden bis zum Ablauf gueltig — die Sperre wurde zwar
       geschrieben, aber nirgends gelesen. */
    const token =
      ExtractJwt.fromAuthHeaderAsBearerToken()(req) ?? extractFromCookie(req);
    if (
      token &&
      (await this.cacheManager.get(gesperrterTokenSchluessel(token)))
    ) {
      throw new UnauthorizedException('Sitzung wurde beendet');
    }

    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    if (!user) {
      throw new UnauthorizedException('Benutzer nicht gefunden');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Konto ist deaktiviert');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Konto ist vorübergehend gesperrt');
    }

    // Hydrate the shape the OrganizationGuard / RolesGuard expect.
    const organizations = (user.userOrganizations ?? []).map((uo) => ({
      id: uo.organizationId,
      role: uo.role,
    }));
    /* Das Super-Admin-Kennzeichen kommt unveraendert als `isSuperAdmin` aus
       der Entity. Frueher stand hier zusaetzlich ein Alias `isSuperadmin`
       (kleines a), weil zwei Guards diese Schreibweise lasen und einer die
       andere. Das hielt nur, solange jeder Weg zu `request.user` beide Felder
       setzte — der API-Token-Pfad tat das nie. Jetzt lesen alle Guards
       dasselbe Feld, und der Alias entfaellt. */
    return Object.assign(user, {
      pending2fa: payload.pending2fa === true,
      organizations,
    });
  }
}
