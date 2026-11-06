import OpenAI from 'openai';
import { Logger } from '@nestjs/common';
import {
  AiClassifyRequest,
  AiCompletionRequest,
  AiInputFile,
  AiProvider,
  AiPurpose,
  AiReasoningEffort,
  AiResult,
  AiStructuredRequest,
} from '../ai-provider.interface';
import { AiProviderError } from '../ai-provider.error';
import {
  assertImageLimit,
  choiceSchema,
  parseStructuredJson,
} from './structured-output.util';

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl?: string;
  modelExtract?: string;
  modelClassify?: string;
  /**
   * `reasoning_effort` je Zweck (AI_REASONING_EFFORT_EXTRACT/_CLASSIFY).
   * Fehlt er, wird der Parameter nicht gesendet.
   */
  reasoningEffort?: Partial<Record<AiPurpose, AiReasoningEffort | ''>>;
  /** AI_MAX_IMAGES_PER_REQUEST; leer/0 = keine eigene Grenze. */
  maxImagesPerRequest?: number;
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
 * Chat Completions gegen eine OpenAI-kompatible API (`OPENAI_BASE_URL`),
 * z. B. OpenAI selbst oder IONOS AI Model Hub. Strukturierte Ausgabe ueber
 * `response_format: json_schema` (strict), Bilder als Data-URLs,
 * `reasoning_effort` je Zweck, wenn konfiguriert.
 *
 * PDFs liest dieser Anbieter nicht direkt: Chat Completions kennt bei den
 * meisten kompatiblen Diensten keine Dokument-Eingabe. AiInputFilesService
 * wandelt eine PDF vorher in Seitenbilder (pdftoppm aus poppler-utils);
 * fehlt das Werkzeug, lehnt der Import PDFs beim Hochladen ab.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);
  private readonly client: Pick<OpenAI, 'chat'> | null;
  private readonly models: Record<AiPurpose, string>;
  private readonly reasoningEffort: Partial<
    Record<AiPurpose, AiReasoningEffort>
  >;
  private readonly maxImages: number | null;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.reasoningEffort = {};
    for (const purpose of ['extract', 'classify'] as const) {
      const effort = options.reasoningEffort?.[purpose];
      if (effort) this.reasoningEffort[purpose] = effort;
    }
    this.maxImages =
      options.maxImagesPerRequest && options.maxImagesPerRequest > 0
        ? options.maxImagesPerRequest
        : null;
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

  maxImagesPerRequest(): number | null {
    return this.maxImages;
  }

  modelFor(purpose: AiPurpose): string {
    return this.models[purpose];
  }

  /** Konfigurierte Reasoning-Stufe (leer: Parameter wird nicht gesendet). */
  reasoningEffortFor(purpose: AiPurpose): AiReasoningEffort | undefined {
    return this.reasoningEffort[purpose];
  }

  async complete(request: AiCompletionRequest): Promise<AiResult<string>> {
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const completion = await this.send(request.purpose, {
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
    assertImageLimit(request.files, this.maxImages);
    const model = this.modelFor(request.purpose);
    const started = Date.now();
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      ...(request.files ?? []).map((file) => this.filePart(file)),
      { type: 'text', text: request.text },
    ];
    const completion = await this.send(request.purpose, {
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
      // Kommt nur an, wenn die Umwandlung in Seitenbilder uebersprungen wurde.
      throw new AiProviderError(
        'PDF wird von diesem Anbieter nicht direkt gelesen — die Seiten müssen vorher als Bilder kommen',
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
    purpose: AiPurpose,
    base: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const model = base.model;
    const effort = this.reasoningEffort[purpose];
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
      effort ? { ...base, reasoning_effort: effort } : base;
    if (!this.client) {
      throw new AiProviderError(
        'OPENAI_API_KEY fehlt',
        undefined,
        false,
        'auth',
      );
    }
    const started = Date.now();
    try {
      const completion = await this.client.chat.completions.create(params);
      const choice = completion.choices?.[0];
      const reasoningTokens =
        completion.usage?.completion_tokens_details?.reasoning_tokens;
      this.logger.log(
        `openai ${model} (${purpose}${effort ? `, reasoning ${effort}` : ''}): ${completion.usage?.prompt_tokens ?? '?'} in / ${completion.usage?.completion_tokens ?? '?'} out${reasoningTokens ? ` (${reasoningTokens} reasoning)` : ''}, ${Date.now() - started} ms, finish=${choice?.finish_reason ?? '-'}`,
      );
      if (!choice) {
        throw new AiProviderError(
          'Das Modell hat keine Antwort geliefert',
          undefined,
          false,
          'invalid_output',
        );
      }
      if (choice.message.refusal) {
        throw new AiProviderError(
          'Das Modell hat die Anfrage abgelehnt',
          undefined,
          false,
          'invalid_output',
        );
      }
      if (choice.finish_reason === 'length') {
        // Typisch fuer Reasoning-Modelle ohne AI_REASONING_EFFORT_*: das
        // Nachdenken verbraucht das ganze Token-Limit, die Antwort bleibt
        // leer. Laut loggen, damit der Ausfall nicht still bleibt.
        const limit = params.max_completion_tokens ?? '?';
        const spentOnReasoning =
          reasoningTokens !== undefined &&
          reasoningTokens > 0 &&
          reasoningTokens >= (completion.usage?.completion_tokens ?? 0) * 0.9;
        const hint = spentOnReasoning
          ? ` — fast alles ging ins Reasoning (${reasoningTokens} Tokens); AI_REASONING_EFFORT_${purpose.toUpperCase()} senken (z. B. ${purpose === 'classify' ? 'none' : 'low'})`
          : '';
        this.logger.warn(
          `openai ${model} (${purpose}): Antwort abgeschnitten, finish=length bei ${completion.usage?.completion_tokens ?? '?'}/${limit} Tokens${hint}`,
        );
        throw new AiProviderError(
          `Die Antwort des Modells war zu lang und wurde abgeschnitten (finish=length, ${completion.usage?.completion_tokens ?? '?'}/${limit} Tokens${reasoningTokens ? `, davon ${reasoningTokens} Reasoning` : ''})`,
          undefined,
          false,
          'invalid_output',
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
