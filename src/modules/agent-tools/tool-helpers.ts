import { z } from 'zod';

import type { PaginatedResult, PaginationDto } from '../../common/dto';
import { AgentToolError, type ToolPreview } from './agent-tool.types';

/** Mehr Zeilen je Antwort gibt es nicht — Antworten sollen knapp bleiben. */
export const MAX_LIMIT = 100;

/** Hoechstens so viele Zeilen holen die Dienste in einem Zug (PaginationDto). */
const SERVICE_MAX_LIMIT = 500;

export const uuid = z.string().uuid();

export const listInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(50)
    .describe('Max. rows (1-100)'),
  offset: z.number().int().min(0).default(0).describe('Rows to skip'),
};

export const confirmInput = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      'false (default): only preview what would change. true: apply the change.',
    ),
};

/** Datum `YYYY-MM-DD` oder ISO-8601 mit Zeit. */
export const dateInput = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    'Expected YYYY-MM-DD or ISO-8601 date-time',
  );

export const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export interface ListResult<T> {
  items: T[];
  total: number;
  /** Naechster `offset`, wenn es weitere Zeilen gibt. */
  nextOffset: number | null;
}

/** Eine fertige Liste ausschneiden (Dienste, die alles liefern). */
export function slice<T>(
  items: T[],
  offset: number,
  limit: number,
): ListResult<T> {
  const page = items.slice(offset, offset + limit);
  const next = offset + limit;
  return {
    items: page,
    total: items.length,
    nextOffset: next < items.length ? next : null,
  };
}

/**
 * Seitenweise blaetternde Dienste mit `offset`/`limit` ansprechen.
 *
 * Passt `offset` auf eine Seite, wird genau diese geholt; sonst wird vom
 * Anfang bis `offset + limit` geholt und ausgeschnitten (bis 500 Zeilen).
 */
export async function windowed<T>(
  fetch: (pagination: PaginationDto) => Promise<PaginatedResult<T>>,
  offset: number,
  limit: number,
  serviceMax = SERVICE_MAX_LIMIT,
): Promise<ListResult<T>> {
  if (offset % limit === 0) {
    const page = offset / limit + 1;
    const result = await fetch({ page, limit } as PaginationDto);
    return {
      items: result.data,
      total: result.meta.total,
      nextOffset: result.meta.hasNext ? offset + limit : null,
    };
  }
  const span = offset + limit;
  if (span > serviceMax) {
    throw new AgentToolError(
      'INVALID_INPUT',
      `offset must be a multiple of limit or offset + limit <= ${serviceMax}`,
    );
  }
  const result = await fetch({ page: 1, limit: span } as PaginationDto);
  const items = result.data.slice(offset, span);
  const next = offset + limit;
  return {
    items,
    total: result.meta.total,
    nextOffset: next < result.meta.total ? next : null,
  };
}

/** Alles holen (bis 500 Zeilen) — fuer Filter, die der Dienst nicht kennt. */
export async function fetchAll<T>(
  fetch: (pagination: PaginationDto) => Promise<PaginatedResult<T>>,
): Promise<T[]> {
  const result = await fetch({
    page: 1,
    limit: SERVICE_MAX_LIMIT,
  } as PaginationDto);
  return result.data;
}

/** Geldbetraege: die Datenbank liefert Dezimalspalten teils als Text. */
export function money(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Nur das Datum, fuer Veranstaltungen und Schichten. */
export function isoDate(value: Date | string | null | undefined): string | null {
  const full = iso(value);
  return full ? full.slice(0, 10) : null;
}

export function preview(
  summary: string,
  details: Record<string, unknown> = {},
): ToolPreview {
  return { preview: true, summary, ...details };
}

export function done(
  summary: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ok: true, summary, ...details };
}

/** Nur definierte Felder — fuer PATCH-artige Aufrufe. */
export function defined<T extends Record<string, unknown>>(
  input: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Vorher/Nachher je geaendertem Feld, fuer die Vorschau. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(after)) {
    const from = before[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
      changes[key] = { from: from ?? null, to };
    }
  }
  return changes;
}

export function notFound(what: string, id: string): AgentToolError {
  return new AgentToolError('NOT_FOUND', `${what} ${id} nicht gefunden`);
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('de') === b.trim().toLocaleLowerCase('de');
}
