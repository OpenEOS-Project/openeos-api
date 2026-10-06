import type { Breadcrumb, Event } from '@sentry/nestjs';

/**
 * Datensparsame Fehlerberichte.
 *
 * Fehlerberichte enthalten nur, was zum Nachvollziehen eines Fehlers noetig
 * ist: Pfad ohne Query, Methode, wenige unkritische Kopfzeilen und hoechstens
 * die Nutzer-ID. Cookies, Authorization, Geraete-Token, Query-Strings,
 * Request-Body, IP-Adressen und E-Mail-Adressen bleiben draussen.
 */

/** Kopfzeilen, die in Fehlerberichten erhalten bleiben (klein geschrieben). */
export const REPORT_HEADER_ALLOWLIST: readonly string[] = [
  'user-agent',
  'accept-language',
  'referer',
  'content-type',
  'x-request-id',
];

/** Kopfzeilen, deren Wert eine URL ist — dort wird die Query entfernt. */
const URL_HEADERS = new Set(['referer']);

/** Entfernt Query-String und Fragment aus einer URL oder einem Pfad. */
export function stripQueryString(url: string): string;
export function stripQueryString(url: unknown): string | undefined;
export function stripQueryString(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Reduziert Kopfzeilen auf die Allowlist. */
export function filterReportHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return result;

  for (const [rawName, rawValue] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    const name = rawName.toLowerCase();
    if (!REPORT_HEADER_ALLOWLIST.includes(name)) continue;

    let value: unknown = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : rawValue;
    if (typeof value !== 'string') continue;
    if (URL_HEADERS.has(name)) value = stripQueryString(value);
    if (value) result[name] = value as string;
  }
  return result;
}

/** Nutzerangabe fuer Fehlerberichte: nur die ID. */
export function reportUser(
  user: { id?: string | number | null } | null | undefined,
): { id: string } | null {
  if (!user || user.id === undefined || user.id === null || user.id === '') {
    return null;
  }
  return { id: String(user.id) };
}

/**
 * Bereinigt ein Sentry-Ereignis (Fehler oder Transaktion) vor dem Versand.
 * Veraendert das Ereignis an Ort und Stelle und gibt es zurueck, damit die
 * Funktion direkt in `beforeSend` / `beforeSendTransaction` passt.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.request) {
    const request = event.request;
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    delete request.env;
    if (typeof request.url === 'string') {
      request.url = stripQueryString(request.url);
    }
    if (request.headers) {
      request.headers = filterReportHeaders(request.headers);
    }
  }

  if (event.user) {
    const user = reportUser(event.user as { id?: string | number });
    if (user) event.user = user;
    else delete event.user;
  }

  if (event.tags && typeof event.tags.url === 'string') {
    event.tags.url = stripQueryString(event.tags.url);
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb);
  }

  // Transaktionen tragen die URL zusaetzlich in den Span-Attributen.
  scrubUrlData(event.contexts?.trace?.data);
  for (const span of event.spans ?? []) {
    scrubUrlData(span.data);
  }

  return event;
}

/** Entfernt Query-Strings aus URLs in Breadcrumbs (z. B. ausgehende HTTP-Aufrufe). */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  scrubUrlData(breadcrumb.data);
  return breadcrumb;
}

/** Attribute, deren Wert eine URL oder ein Pfad samt Query sein kann. */
const URL_KEYS = [
  'url',
  'from',
  'to',
  'http.url',
  'http.target',
  'url.full',
  'url.path',
];

/** Attribute, die nur aus Query oder Fragment bestehen. */
const QUERY_KEYS = ['http.query', 'http.fragment', 'url.query', 'url.fragment'];

function scrubUrlData(data: Record<string, unknown> | undefined): void {
  if (!data || typeof data !== 'object') return;
  for (const key of URL_KEYS) {
    if (typeof data[key] === 'string') {
      data[key] = stripQueryString(data[key]);
    }
  }
  for (const key of QUERY_KEYS) {
    delete data[key];
  }
}
