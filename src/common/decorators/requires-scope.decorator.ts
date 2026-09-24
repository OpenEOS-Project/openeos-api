import { SetMetadata } from '@nestjs/common';

export const REQUIRES_SCOPE_KEY = 'requiresScope';

/**
 * Öffnet einen Endpunkt für API-Tokens — und nur für solche mit diesem
 * Geltungsbereich.
 *
 * Ohne diese Markierung weist der Guard jeden API-Token ab. Das ist die
 * wichtigere Hälfte der Regel: Ein Token fürs Monitoring soll Zahlen
 * lesen dürfen, nicht in eine Organisation schlüpfen oder Einstellungen
 * ändern können. Ihm pauschal die Rechte seines Besitzers zu geben,
 * hätte aus einem Lesezugang einen Generalschlüssel gemacht.
 */
export const RequiresScope = (scope: string) => SetMetadata(REQUIRES_SCOPE_KEY, scope);
