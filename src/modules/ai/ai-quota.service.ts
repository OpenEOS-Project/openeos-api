import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiFeature, AiUsage, AiUsageStatus } from '../../database/entities';
import { ErrorCodes, ErrorMessages } from '../../common/constants/error-codes';
import { AI_PROVIDER } from './ai-provider.interface';
import type { AiProvider } from './ai-provider.interface';
import { AiConfig, readAiConfig } from './ai-provider.factory';
import { berlinDayStart, berlinNextDayStart } from './berlin-day.util';

export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  /** Beginn des naechsten Berliner Kalendertags (ISO). */
  resetAt: string;
}

export interface UsageSettlement {
  status: Exclude<AiUsageStatus, 'reserved'>;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/**
 * Tageskontingente je Organisation (Europe/Berlin) aus `ai_usage`.
 *
 * Ablauf: `reserve()` prueft das Kontingent und schreibt einen Eintrag
 * `reserved`; nach dem Aufruf setzt `settle()` Tokens, Dauer und `ok`
 * oder `error`. Gezaehlt werden `reserved` und `ok` — ein Aufruf, der
 * beim Anbieter scheitert, kostet kein Kontingent. Zwei gleichzeitige
 * Anfragen koennen das Limit um eins ueberschreiten; das ist bei
 * Tageskontingenten dieser Groesse unerheblich.
 */
@Injectable()
export class AiQuotaService {
  private readonly logger = new Logger(AiQuotaService.name);
  private readonly config: AiConfig;

  constructor(
    @InjectRepository(AiUsage)
    private readonly usageRepository: Repository<AiUsage>,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    configService: ConfigService,
  ) {
    this.config = readAiConfig(configService);
  }

  limitFor(feature: AiFeature): number {
    switch (feature) {
      case 'menu_import':
        return this.config.menuImportsPerDay;
      case 'icon_suggest':
        return this.config.classifyPerDay;
    }
  }

  async getQuota(
    organizationId: string,
    feature: AiFeature,
    now = new Date(),
  ): Promise<QuotaStatus> {
    const limit = this.limitFor(feature);
    const used = await this.usedToday(organizationId, feature, now);
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: berlinNextDayStart(now).toISOString(),
    };
  }

  /**
   * Reserviert `units` Einheiten oder wirft 429 AI_QUOTA_EXCEEDED mit
   * `params.resetAt`.
   */
  async reserve(
    organizationId: string,
    userId: string | null,
    feature: AiFeature,
    units = 1,
    now = new Date(),
  ): Promise<AiUsage> {
    const quota = await this.getQuota(organizationId, feature, now);
    if (quota.used + units > quota.limit) {
      throw new HttpException(
        {
          code: ErrorCodes.AI_QUOTA_EXCEEDED,
          message: ErrorMessages[ErrorCodes.AI_QUOTA_EXCEEDED],
          params: {
            feature,
            limit: quota.limit,
            used: quota.used,
            resetAt: quota.resetAt,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const usage = this.usageRepository.create({
      organizationId,
      userId,
      feature,
      provider: this.provider.name,
      model: this.provider.modelFor(
        feature === 'menu_import' ? 'extract' : 'classify',
      ),
      units,
      status: 'reserved',
    });
    return this.usageRepository.save(usage);
  }

  async settle(usageId: string, result: UsageSettlement): Promise<void> {
    try {
      await this.usageRepository.update(
        { id: usageId },
        {
          status: result.status,
          ...(result.model ? { model: result.model } : {}),
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
          durationMs: result.durationMs ?? 0,
        },
      );
    } catch (error) {
      this.logger.error(
        `ai_usage ${usageId} nicht aktualisiert: ${(error as Error).message}`,
      );
    }
  }

  private async usedToday(
    organizationId: string,
    feature: AiFeature,
    now: Date,
  ): Promise<number> {
    const row = await this.usageRepository
      .createQueryBuilder('usage')
      .select('COALESCE(SUM(usage.units), 0)', 'used')
      .where('usage.organizationId = :organizationId', { organizationId })
      .andWhere('usage.feature = :feature', { feature })
      .andWhere('usage.status IN (:...statuses)', {
        statuses: ['reserved', 'ok'],
      })
      .andWhere('usage.createdAt >= :start', { start: berlinDayStart(now) })
      .getRawOne<{ used: string | number }>();
    return Number(row?.used ?? 0);
  }
}
