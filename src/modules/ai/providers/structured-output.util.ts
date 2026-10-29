import { AiProviderError } from '../ai-provider.error';

/**
 * Antworttext eines Modells als JSON lesen. Strukturierte Ausgabe liefert
 * reines JSON; manche OpenAI-kompatible Anbieter packen es trotzdem in
 * einen ```json-Zaun — der wird toleriert, mehr nicht.
 */
export function parseStructuredJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AiProviderError(
      'Das Modell hat keine gültige strukturierte Antwort geliefert',
    );
  }
}

/** Schema fuer `classify`: genau eine Auswahl oder null. */
export function choiceSchema(choices: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      choice: {
        type: ['string', 'null'],
        enum: [...choices, null],
      },
    },
    required: ['choice'],
    additionalProperties: false,
  };
}

/**
 * Fremder Inhalt wird als Daten gekennzeichnet, nicht als Anweisung.
 * Der Systemprompt sagt dem Modell, dass alles zwischen den Markierungen
 * Speisekarte ist und nie Instruktionen enthaelt, die es befolgen soll.
 */
export function wrapUntrusted(label: string, text: string): string {
  const safe = text.replace(/<\/?untrusted[^>]*>/gi, '');
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}
