import OpenAI from 'openai';
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

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl?: string;
  modelExtract?: string;
  modelClassify?: string;
  /** Nur fuer Tests: fertiger Client statt eines echten. */
  client?: Pick<OpenAI, 'chat'>;
}

export const OPENAI_DEFAULT_MODELS: Record<AiPurpose, string> = {
  extract: 'gpt-5',
  classify: 'gpt-5-mini',
};

const DEFAULT_MAX_OUTPUT_TOKENS: Record<AiPurpose, number> = {
  extract: 16000,
  classify: 1024,
};

/**
 * Chat Completions gegen eine OpenAI-kompatible API (`OPENAI_BASE_URL`).
 * Strukturierte Ausgabe ueber `response_format: json_schema` (strict),
 * Bilder als Data-URLs.
 *
 * PDFs liest dieser Anbieter nicht: Chat Completions kennt bei den
 * meisten kompatiblen Diensten keine Dokument-Eingabe, und die API hat
 * keine Bibliothek, die Seiten in Bilder wandelt. Ein Import mit PDF wird
 * fuer diesen Anbieter schon beim Hochladen abgelehnt
 * (MENU_IMPORT_INVALID_FILES) — Fotos der Seiten gehen immer.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly client: Pick<OpenAI, 'chat'> | null;
  private readonly models: Record<AiPurpose, string>;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.models = {
      extract: options.modelExtract || OPENAI_DEFAULT_MODELS.extract,
      classify: options.modelClassify || OPENAI_DEFAULT_MODELS.classify,
    };
    this.client =
      options.client ??
      (options.apiKey
        ? new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.baseUrl || undefined,
          })
        : null);
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  supportsPdf(): boolean {
    return false;
  }

  modelFor(purpose: AiPurpose): string {
    return this.models[purpose];
  }

  async complete(request: AiCompletionRequest): Promise<AiResult<string>> {
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const completion = await this.send(model, {
      model,
      max_completion_tokens:
        request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[request.purpose],
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.text },
      ],
    });
    return {
      value: this.textOf(completion),
      model,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - started,
    };
  }

  async extractStructured<T>(
    request: AiStructuredRequest,
  ): Promise<AiResult<T>> {
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      ...(request.files ?? []).map((file) => this.filePart(file)),
      { type: 'text', text: request.text },
    ];
    const completion = await this.send(model, {
      model,
      max_completion_tokens:
        request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[request.purpose],
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      },
    });
    return {
      value: parseStructuredJson<T>(this.textOf(completion)),
      model,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
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

  private filePart(
    file: AiInputFile,
  ): OpenAI.Chat.Completions.ChatCompletionContentPart {
    if (file.mediaType === 'application/pdf') {
      throw new AiProviderError(
        'PDF wird von diesem Anbieter nicht unterstützt — bitte Fotos der Seiten hochladen',
      );
    }
    return {
      type: 'image_url',
      image_url: {
        url: `data:${file.mediaType};base64,${file.data.toString('base64')}`,
      },
    };
  }

  private async send(
    model: string,
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    if (!this.client) {
      throw new AiProviderError('OPENAI_API_KEY fehlt');
    }
    const started = Date.now();
    try {
      const completion = await this.client.chat.completions.create(params);
      const choice = completion.choices?.[0];
      this.logger.log(
        `openai ${model}: ${completion.usage?.prompt_tokens ?? '?'} in / ${completion.usage?.completion_tokens ?? '?'} out, ${Date.now() - started} ms, finish=${choice?.finish_reason ?? '-'}`,
      );
      if (!choice) {
        throw new AiProviderError('Das Modell hat keine Antwort geliefert');
      }
      if (choice.message.refusal) {
        throw new AiProviderError('Das Modell hat die Anfrage abgelehnt');
      }
      if (choice.finish_reason === 'length') {
        throw new AiProviderError(
          'Die Antwort des Modells war zu lang und wurde abgeschnitten',
        );
      }
      return completion;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw this.translate(error);
    }
  }

  private textOf(completion: OpenAI.Chat.Completions.ChatCompletion): string {
    return completion.choices?.[0]?.message?.content ?? '';
  }

  private translate(error: unknown): AiProviderError {
    if (error instanceof OpenAI.RateLimitError) {
      this.logger.warn(`openai: rate limited (${error.status})`);
      return new AiProviderError('Anbieter: Rate-Limit erreicht', 429, true);
    }
    if (error instanceof OpenAI.AuthenticationError) {
      this.logger.error('openai: API-Schlüssel abgelehnt');
      return new AiProviderError('Anbieter: Schlüssel abgelehnt', 401);
    }
    if (error instanceof OpenAI.APIError) {
      // `status` ist im SDK generisch typisiert (TStatus) — hier eine Zahl oder undefined.
      const status =
        typeof error.status === 'number' ? error.status : undefined;
      this.logger.warn(`openai: API error ${status ?? '-'}`);
      return new AiProviderError(
        `Anbieter: Fehler ${status ?? ''}`.trim(),
        status,
        (status ?? 500) >= 500,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`openai: ${message}`);
    return new AiProviderError('Anbieter nicht erreichbar', undefined, true);
  }
}
