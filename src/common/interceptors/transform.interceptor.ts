import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Response<T> {
  data: T;
  meta?: Record<string, unknown>;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, Response<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    return next.handle().pipe(
      map((data) => {
        // Streamable file responses (PDF export etc.) must NOT be wrapped —
        // NestJS handles them specially and pipes the underlying stream
        // straight to the response. Wrapping them in { data } would JSON-
        // serialize the wrapper and produce a corrupted file.
        if (data instanceof StreamableFile) {
          return data;
        }
        // Buffers + Node streams: ditto.
        if (Buffer.isBuffer(data) || (data && typeof (data as { pipe?: unknown })?.pipe === 'function')) {
          return data;
        }

        // Wenn die Response bereits das gewünschte Format hat, nicht transformieren
        if (data && typeof data === 'object' && 'data' in data) {
          return data;
        }

        // Wenn es ein Array ist mit meta Informationen
        if (Array.isArray(data)) {
          return { data };
        }

        return { data };
      }),
    );
  }
}
