import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { REVEAL_SECRETS_KEY } from '../decorators/reveal-secrets.decorator';
import { redactResponse } from '../utils/response-redaction.util';

/**
 * Letzte Station jeder HTTP-Antwort: entfernt Zugangsdaten und Pruefwerte
 * und maskiert Zahlungs-Zugangsdaten, egal ueber welchen Endpunkt und
 * welche geladene Relation sie in die Antwort geraten sind.
 *
 * Bewusst global statt pro Controller — der Fehler, den das behebt, war
 * genau das Vergessen einzelner Stellen. Siehe response-redaction.util.ts.
 * Einzelne Felder gibt nur `@RevealSecrets(...)` am Handler frei.
 */
@Injectable()
export class RedactSecretsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler =
      context.getType() === 'http' ? context.getHandler() : undefined;
    const reveal =
      (handler &&
        (Reflect.getMetadata(REVEAL_SECRETS_KEY, handler) as
          | string[]
          | undefined)) ||
      [];
    return next
      .handle()
      .pipe(map((data: unknown) => redactResponse(data, reveal)));
  }
}
