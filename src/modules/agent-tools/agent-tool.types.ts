import { z } from 'zod';

import type { User } from '../../database/entities';
import type { RequestApiToken } from '../../common/types/request.types';
import type { TokenScope } from '../api-tokens/api-scopes';

/**
 * Wer ruft — nie aus der Eingabe, immer aus dem Token.
 *
 * `organizationId` ist die Organisation des Tokens; die Handler reichen
 * sie an die Dienste weiter, die Rolle und Modul-Berechtigungen des
 * Besitzers wie bei einer Sitzung pruefen.
 */
export interface AgentToolContext {
  user: User;
  organizationId: string;
  apiToken: RequestApiToken;
  client?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Ein Werkzeug, wie es der MCP-Server (und spaeter der Assistent in der
 * App) anbietet. Beschreibung auf Englisch — Modelle arbeiten damit am
 * besten; Texte, die an Menschen gehen (`summary`), bleiben Deutsch.
 */
export interface AgentTool<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: Schema;
  scope: TokenScope;
  /** Schreibend: Eingabe traegt `confirm`, ohne `confirm: true` nur Vorschau. */
  mutating: boolean;
  handler: (ctx: AgentToolContext, input: z.infer<Schema>) => Promise<unknown>;
}

/** Vorschau einer schreibenden Aktion — es wurde nichts geaendert. */
export interface ToolPreview {
  preview: true;
  summary: string;
  [key: string]: unknown;
}

export function isPreview(value: unknown): value is ToolPreview {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { preview?: unknown }).preview === true
  );
}

/** Typsicheres Anlegen, damit `input` im Handler den Schema-Typ hat. */
export function defineTool<Schema extends z.ZodTypeAny>(
  tool: AgentTool<Schema>,
): AgentTool<Schema> {
  return tool;
}

export type AgentToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'SCOPE_MISSING'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT';

/** Fehler aus der Werkzeugschicht selbst (nicht aus den Diensten). */
export class AgentToolError extends Error {
  constructor(
    readonly code: AgentToolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}
