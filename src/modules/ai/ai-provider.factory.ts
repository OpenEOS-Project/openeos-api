import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, AiProviderName } from './ai-provider.interface';
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
      const provider = new AnthropicProvider({
        apiKey: config.anthropicApiKey,
        modelExtract: config.modelExtract,
        modelClassify: config.modelClassify,
      });
      logger.log(
        `Assistent: anthropic (${provider.modelFor('extract')} / ${provider.modelFor('classify')})`,
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
      });
      logger.log(
        `Assistent: openai-kompatibel ${config.openaiBaseUrl} (${provider.modelFor('extract')} / ${provider.modelFor('classify')})`,
      );
      return provider;
    }
    default:
      logger.log('Assistent: aus (AI_PROVIDER=none)');
      return new NoneProvider();
  }
}
