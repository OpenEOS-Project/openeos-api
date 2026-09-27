import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { redactResponse } from '../utils/response-redaction.util';

/**
 * Letzte Station jeder HTTP-Antwort: entfernt Benutzer-Geheimnisse und
 * maskiert Zahlungs-Zugangsdaten, egal ueber welchen Endpunkt und welche
 * geladene Relation sie in die Antwort geraten sind.
 *
 * Bewusst global statt pro Controller — der Fehler, den das behebt, war
 * genau das Vergessen einzelner Stellen. Siehe response-redaction.util.ts.
 */
@Injectable()
export class RedactSecretsInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((data: unknown) => redactResponse(data)));
  }
}
