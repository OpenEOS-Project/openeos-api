import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
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
