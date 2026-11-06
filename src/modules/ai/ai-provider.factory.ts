import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_REASONING_EFFORTS,
  AiProvider,
  AiProviderName,
  AiReasoningEffort,
} from './ai-provider.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';
import { NoneProvider } from './providers/none.provider';

export interface AiConfig {
  provider: AiProviderName;
  anthropicApiKey: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  modelExtract: string;
  modelClassify: string;
  menuImportsPerDay: number;
  menuPagesPerImport: number;
  classifyPerDay: number;
  maxUploadMb: number;
  /** Nur `openai`; leer = `reasoning_effort` nicht senden. */
  reasoningEffortExtract: AiReasoningEffort | '';
  reasoningEffortClassify: AiReasoningEffort | '';
  /** 0 = keine eigene Grenze. */
  maxImagesPerRequest: number;
}

function effortOf(value: unknown): AiReasoningEffort | '' {
  return (AI_REASONING_EFFORTS as readonly unknown[]).includes(value)
    ? (value as AiReasoningEffort)
    : '';
}

export function readAiConfig(configService: ConfigService): AiConfig {
  const config = configService.get<AiConfig>('ai');
  return {
    provider: config?.provider ?? 'none',
    anthropicApiKey: config?.anthropicApiKey ?? '',
    openaiApiKey: config?.openaiApiKey ?? '',
    openaiBaseUrl: config?.openaiBaseUrl ?? 'https://api.openai.com/v1',
    modelExtract: config?.modelExtract ?? '',
    modelClassify: config?.modelClassify ?? '',
    menuImportsPerDay: config?.menuImportsPerDay ?? 5,
    menuPagesPerImport: config?.menuPagesPerImport ?? 6,
    classifyPerDay: config?.classifyPerDay ?? 500,
    maxUploadMb: config?.maxUploadMb ?? 10,
    reasoningEffortExtract: effortOf(config?.reasoningEffortExtract),
    reasoningEffortClassify: effortOf(config?.reasoningEffortClassify),
    maxImagesPerRequest:
      Number.isFinite(config?.maxImagesPerRequest) &&
      (config?.maxImagesPerRequest ?? 0) > 0
        ? (config?.maxImagesPerRequest as number)
        : 0,
  };
}

/**
 * Baut den Anbieter aus `AI_PROVIDER`. Ein gesetzter Anbieter ohne
 * Schluessel ist ein Konfigurationsfehler, der beim Start auffallen soll:
 * er wird geloggt, und der Anbieter meldet sich als nicht verfuegbar
 * (alle Assistent-Endpunkte antworten dann 404 AI_DISABLED).
 */
export function createAiProvider(config: AiConfig): AiProvider {
  const logger = new Logger('AiProvider');
  switch (config.provider) {
    case 'anthropic': {
      if (!config.anthropicApiKey) {
        logger.error('AI_PROVIDER=anthropic, aber ANTHROPIC_API_KEY fehlt');
      }
      if (config.reasoningEffortExtract || config.reasoningEffortClassify) {
        logger.warn(
          'AI_REASONING_EFFORT_* gilt nur für AI_PROVIDER=openai und wird ignoriert',
        );
      }
      const provider = new AnthropicProvider({
        apiKey: config.anthropicApiKey,
        modelExtract: config.modelExtract,
        modelClassify: config.modelClassify,
        maxImagesPerRequest: config.maxImagesPerRequest,
      });
      logger.log(
        `Assistent: anthropic (${provider.modelFor('extract')} / ${provider.modelFor('classify')}${limitText(provider)})`,
      );
      return provider;
    }
    case 'openai': {
      if (!config.openaiApiKey) {
        logger.error('AI_PROVIDER=openai, aber OPENAI_API_KEY fehlt');
      }
      const provider = new OpenAiCompatibleProvider({
        apiKey: config.openaiApiKey,
        baseUrl: config.openaiBaseUrl,
        modelExtract: config.modelExtract,
        modelClassify: config.modelClassify,
        reasoningEffort: {
          extract: config.reasoningEffortExtract,
          classify: config.reasoningEffortClassify,
        },
        maxImagesPerRequest: config.maxImagesPerRequest,
      });
      const effort = (purpose: 'extract' | 'classify') =>
        provider.reasoningEffortFor(purpose)
          ? `, reasoning ${provider.reasoningEffortFor(purpose)}`
          : '';
      logger.log(
        `Assistent: openai-kompatibel ${config.openaiBaseUrl} (${provider.modelFor('extract')}${effort('extract')} / ${provider.modelFor('classify')}${effort('classify')}${limitText(provider)})`,
      );
      return provider;
    }
    default:
      logger.log('Assistent: aus (AI_PROVIDER=none)');
      return new NoneProvider();
  }
}

function limitText(provider: AiProvider): string {
  const max = provider.maxImagesPerRequest();
  return max ? `, höchstens ${max} Bilder je Aufruf` : '';
}
