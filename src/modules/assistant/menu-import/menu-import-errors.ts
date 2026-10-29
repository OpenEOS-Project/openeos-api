import { AiProviderError } from '../../ai/ai-provider.error';
import type { AiProviderErrorKind } from '../../ai/ai-provider.error';

/**
 * Was die Web-App bei einem fehlgeschlagenen Import anzeigt — kurz, auf
 * Deutsch, du-Form. Die Rohmeldung des Anbieters (Statuscodes, SDK-Texte)
 * bleibt im Log und in `menu_imports.error_detail`.
 */
export const MENU_IMPORT_ERROR_TEXTS: Record<AiProviderErrorKind, string> = {
  auth: 'Der Anbieter hat den Zugang abgelehnt – bitte Schlüssel prüfen.',
  rate_limit:
    'Der Anbieter ist gerade überlastet, bitte später erneut versuchen.',
  unavailable: 'Keine Antwort vom Anbieter – bitte später erneut versuchen.',
  invalid_output:
    'Die Speisekarte konnte nicht gelesen werden – versuch ein schärferes Foto oder den Text.',
  other:
    'Die Speisekarte konnte nicht ausgewertet werden – bitte versuch es noch einmal.',
};

export interface MenuImportFailure {
  /** Text fuer `menu_imports.error` (Nutzer). */
  message: string;
  /** Rohmeldung fuer Log und `menu_imports.error_detail`. */
  detail: string;
}

/** Macht aus einem beliebigen Fehler der Auswertung Nutzertext + Rohmeldung. */
export function describeMenuImportFailure(error: unknown): MenuImportFailure {
  const detail =
    error instanceof Error
      ? error.message || error.name
      : typeof error === 'string' && error
        ? error
        : 'Unbekannter Fehler';
  const kind: AiProviderErrorKind =
    error instanceof AiProviderError ? error.kind : 'other';
  return {
    message: MENU_IMPORT_ERROR_TEXTS[kind],
    detail: detail.slice(0, 2000),
  };
}
