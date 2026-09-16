import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_TWO_FACTOR_KEY = 'allowPendingTwoFactor';

/**
 * Erlaubt den Zwischenausweis zwischen Passwort und zweitem Faktor.
 *
 * Ohne diese Markierung weist der JwtAuthGuard solche Token ab. Der
 * Standard ist damit die sichere Seite: ein neuer Endpunkt muss die
 * Ausnahme ausdruecklich wollen, nicht daran denken, sie auszuschliessen.
 */
export const AllowPendingTwoFactor = () => SetMetadata(ALLOW_PENDING_TWO_FACTOR_KEY, true);
