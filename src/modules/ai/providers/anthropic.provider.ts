import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  AiClassifyRequest,
  AiCompletionRequest,
  AiInputFile,
  AiProvider,
  AiPurpose,
  AiResult,
  AiStructuredRequest,
} from '../ai-provider.interface';
import { AiProviderError } from '../ai-provider.error';
import { choiceSchema, parseStructuredJson } from './structured-output.util';

export interface AnthropicProviderOptions {
  apiKey: string;
  modelExtract?: string;
  modelClassify?: string;
  /** Nur fuer Tests: fertiger Client statt eines echten. */
  client?: Pick<Anthropic, 'messages'>;
}

export const ANTHROPIC_DEFAULT_MODELS: Record<AiPurpose, string> = {
  extract: 'claude-sonnet-5-5',
  classify: 'claude-haiku-4-5-20251001',
};

const DEFAULT_MAX_OUTPUT_TOKENS: Record<AiPurpose, number> = {
  extract: 16000,
  classify: 1024,
};

/**
 * Anthropic Messages API. Strukturierte Ausgabe ueber
 * `output_config.format` (JSON-Schema), Bilder und PDFs als
 * Base64-Bloecke im selben Aufruf.
 *
 * Protokolliert werden Modell, Dauer und Tokens — nie Dateiinhalte, nie
 * der Schluessel.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Pick<Anthropic, 'messages'> | null;
  private readonly models: Record<AiPurpose, string>;

  constructor(options: AnthropicProviderOptions) {
    this.models = {
      extract: options.modelExtract || ANTHROPIC_DEFAULT_MODELS.extract,
      classify: options.modelClassify || ANTHROPIC_DEFAULT_MODELS.classify,
    };
    this.client =
      options.client ??
      (options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : null);
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  supportsPdf(): boolean {
    return true;
  }

  modelFor(purpose: AiPurpose): string {
    return this.models[purpose];
  }

  async complete(request: AiCompletionRequest): Promise<AiResult<string>> {
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const response = await this.send(model, {
      model,
      max_tokens:
        request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[request.purpose],
      system: request.system,
      messages: [{ role: 'user', content: request.text }],
    });
    return {
      value: this.textOf(response),
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs: Date.now() - started,
    };
  }

  async extractStructured<T>(
    request: AiStructuredRequest,
  ): Promise<AiResult<T>> {
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [
      ...(request.files ?? []).map((file) => this.fileBlock(file)),
      { type: 'text', text: request.text },
    ];
    const response = await this.send(model, {
      model,
      max_tokens:
        request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[request.purpose],
      system: request.system,
      messages: [{ role: 'user', content }],
      output_config: {
        format: { type: 'json_schema', schema: request.schema },
      },
    });
    return {
      value: parseStructuredJson<T>(this.textOf(response)),
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs: Date.now() - started,
    };
  }

  async classify(request: AiClassifyRequest): Promise<AiResult<string | null>> {
    const result = await this.extractStructured<{ choice: string | null }>({
      purpose: 'classify',
      system: request.system,
      text: request.text,
      schemaName: 'choice',
      schema: choiceSchema(request.choices),
    });
    const choice = result.value?.choice ?? null;
    return {
      ...result,
      value:
        choice !== null && request.choices.includes(choice) ? choice : null,
    };
  }

  private fileBlock(file: AiInputFile): Anthropic.ContentBlockParam {
    const data = file.data.toString('base64');
    if (file.mediaType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      };
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: file.mediaType, data },
    };
  }

  private async send(
    model: string,
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    if (!this.client) {
      throw new AiProviderError('ANTHROPIC_API_KEY fehlt');
    }
    const started = Date.now();
    try {
      const response = await this.client.messages.create(params);
      this.logger.log(
        `anthropic ${model}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, ${Date.now() - started} ms, stop=${response.stop_reason ?? '-'}`,
      );
      if (response.stop_reason === 'refusal') {
        throw new AiProviderError('Das Modell hat die Anfrage abgelehnt');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AiProviderError(
          'Die Antwort des Modells war zu lang und wurde abgeschnitten',
        );
      }
      return response;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw this.translate(error);
    }
  }

  private textOf(response: Anthropic.Message): string {
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  private translate(error: unknown): AiProviderError {
    if (error instanceof Anthropic.RateLimitError) {
      this.logger.warn(`anthropic: rate limited (${error.status})`);
      return new AiProviderError('Anbieter: Rate-Limit erreicht', 429, true);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      this.logger.error('anthropic: API-Schlüssel abgelehnt');
      return new AiProviderError('Anbieter: Schlüssel abgelehnt', 401);
    }
    if (error instanceof Anthropic.APIError) {
      // `status` ist im SDK generisch typisiert (TStatus) — hier eine Zahl oder undefined.
      const status =
        typeof error.status === 'number' ? error.status : undefined;
      this.logger.warn(`anthropic: API error ${status ?? '-'}`);
      return new AiProviderError(
        `Anbieter: Fehler ${status ?? ''}`.trim(),
        status,
        (status ?? 500) >= 500,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`anthropic: ${message}`);
    return new AiProviderError('Anbieter nicht erreichbar', undefined, true);
  }
}
