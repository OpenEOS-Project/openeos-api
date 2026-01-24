import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body } = request;
    const requestId = request.headers['x-request-id'] || this.generateRequestId();
    const userAgent = request.headers['user-agent'] || 'unknown';
    const ip = request.ip;

    const now = Date.now();

    // Füge requestId zur Response hinzu
    const response = context.switchToHttp().getResponse();
    response.setHeader('X-Request-Id', requestId);

    this.logger.log(
      `[${requestId}] ${method} ${url} - IP: ${ip} - UA: ${userAgent.substring(0, 50)}`,
    );

    if (process.env.NODE_ENV === 'development' && body && Object.keys(body).length > 0) {
      this.logger.debug(`[${requestId}] Body: ${JSON.stringify(body).substring(0, 500)}`);
    }

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = response.statusCode;
          const duration = Date.now() - now;
          this.logger.log(`[${requestId}] ${method} ${url} - ${statusCode} - ${duration}ms`);
        },
        error: (error) => {
          const statusCode = error.status || 500;
          const duration = Date.now() - now;
          this.logger.error(
            `[${requestId}] ${method} ${url} - ${statusCode} - ${duration}ms - ${error.message}`,
          );
        },
      }),
    );
  }

  private generateRequestId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
