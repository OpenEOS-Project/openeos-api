import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { User } from '../../database/entities';
import {
  isNewsletterSubscribed,
  newsletterUnsubscribeUrl,
  verifyNewsletterUnsubscribeToken,
} from './newsletter-token';

export interface NewsletterStatus {
  subscribed: boolean;
  /** Letzte Einwilligung (bleibt nach dem Widerruf als Nachweis stehen). */
  consentedAt: Date | null;
  /** Letzter Widerruf. */
  withdrawnAt: Date | null;
  /** Ohne bestaetigte Adresse wirkt die Einwilligung noch nicht. */
  emailVerified: boolean;
}

/**
 * Einwilligung in Neuigkeiten per E-Mail (Datenschutzerklaerung 4.5, 13.3):
 * erteilen und widerrufen in den Kontoeinstellungen, widerrufen ueber den
 * signierten Abmeldelink. Beide Zeitpunkte bleiben gespeichert, damit die
 * Einwilligung nachweisbar bleibt. Versendet wird (noch) nichts.
 */
@Injectable()
export class NewsletterService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

  private get secret(): string {
    return this.configService.get<string>('jwt.secret') ?? '';
  }

  static status(user: User): NewsletterStatus {
    return {
      subscribed: isNewsletterSubscribed(user),
      consentedAt: user.newsletterOptInAt ?? null,
      withdrawnAt: user.newsletterOptOutAt ?? null,
      emailVerified: !!user.emailVerifiedAt,
    };
  }

  async get(userId: string): Promise<NewsletterStatus> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });
    return NewsletterService.status(user);
  }

  async set(userId: string, subscribed: boolean): Promise<NewsletterStatus> {
    const user = await this.userRepository.findOneOrFail({
      where: { id: userId },
    });
    if (subscribed !== isNewsletterSubscribed(user)) {
      const now = new Date();
      if (subscribed) user.newsletterOptInAt = now;
      else user.newsletterOptOutAt = now;
      await this.userRepository.update(user.id, {
        newsletterOptInAt: user.newsletterOptInAt,
        newsletterOptOutAt: user.newsletterOptOutAt,
      });
    }
    return NewsletterService.status(user);
  }

  /** Abmelden ueber den Link; wiederholbar, verraet nicht, ob es das Konto gibt. */
  async unsubscribe(token: string | undefined): Promise<void> {
    const userId = verifyNewsletterUnsubscribeToken(token, this.secret);
    if (!userId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.NEWSLETTER_TOKEN_INVALID,
        message: 'Dieser Abmeldelink ist ungültig.',
      });
    }
    const user = await this.userRepository.findOne({
      where: { id: userId, deletedAt: IsNull() },
    });
    if (user && isNewsletterSubscribed(user)) {
      await this.userRepository.update(user.id, {
        newsletterOptOutAt: new Date(),
      });
    }
  }

  /** Abmeldelink fuer kuenftige Newsletter-Mails. */
  unsubscribeUrl(userId: string): string {
    const appUrl =
      this.configService.get<string>('APP_URL') || 'https://app.openeos.de';
    return newsletterUnsubscribeUrl(appUrl, userId, this.secret);
  }
}
