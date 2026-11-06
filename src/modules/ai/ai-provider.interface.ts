/**
 * Schnittstelle zum Modellanbieter.
 *
 * Alles, was ein Modell fuer OpenEOS tut, laeuft ueber strukturierte
 * Ausgabe gegen ein festes JSON-Schema — nie ueber freie Textantworten,
 * die jemand weiterverarbeitet. Speisekarten sind fremder Inhalt: der
 * Aufrufer verpackt ihn als Daten, das Schema begrenzt, was zurueckkommt,
 * und die Antwort wird vor dem Speichern mit class-validator geprueft.
 *
 * Implementierungen: AnthropicProvider, OpenAiCompatibleProvider,
 * NoneProvider (alles aus). Welche laeuft, entscheidet `AI_PROVIDER`.
 */
export type AiProviderName = 'anthropic' | 'openai' | 'none';

/** Welches Modell: Extraktion mit Bildern oder billige Klassifikation. */
export type AiPurpose = 'extract' | 'classify';

/**
 * `reasoning_effort` fuer OpenAI-kompatible Modelle (AI_REASONING_EFFORT_*).
 * Anthropic kennt den Parameter nicht und ignoriert die Einstellung.
 */
export const AI_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export type AiImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface AiInputFile {
  mediaType: AiImageMediaType | 'application/pdf';
  data: Buffer;
}

export interface AiCompletionRequest {
  purpose: AiPurpose;
  system: string;
  text: string;
  maxOutputTokens?: number;
}

export interface AiStructuredRequest {
  purpose: AiPurpose;
  system: string;
  /** Nutzertext (fremder Inhalt, vom Aufrufer als Daten gekennzeichnet). */
  text: string;
  /** Bilder oder eine PDF, in Seitenreihenfolge. */
  files?: AiInputFile[];
  /** JSON-Schema (Objekt, `additionalProperties: false`, alles `required`). */
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface AiClassifyRequest {
  system: string;
  text: string;
  /** Erlaubte Antworten; das Modell waehlt genau eine oder `null`. */
  choices: string[];
}

export interface AiResult<T> {
  value: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  /** Schluessel vorhanden und Anbieter nicht `none`. */
  isAvailable(): boolean;
  /**
   * Kann der Anbieter PDF-Seiten direkt lesen? Sonst wandelt
   * AiInputFilesService eine PDF vorher in Seitenbilder (poppler-utils).
   */
  supportsPdf(): boolean;
  /**
   * Hoechstens so viele Bilder je Aufruf (AI_MAX_IMAGES_PER_REQUEST),
   * `null` = keine eigene Grenze. Der Speisekarten-Import teilt laengere
   * Karten in mehrere Aufrufe.
   */
  maxImagesPerRequest(): number | null;
  modelFor(purpose: AiPurpose): string;
  complete(request: AiCompletionRequest): Promise<AiResult<string>>;
  extractStructured<T>(request: AiStructuredRequest): Promise<AiResult<T>>;
  classify(request: AiClassifyRequest): Promise<AiResult<string | null>>;
}

/** Injection-Token fuer den konfigurierten Anbieter. */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
