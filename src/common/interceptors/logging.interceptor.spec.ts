import {
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { LoggingInterceptor, requestLogPath } from './logging.interceptor';

const TOKEN = 'a'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';
const UUID = '2a3f1c52-4f43-4a3e-9f8e-0f2b8f3f1a22';

describe('requestLogPath', () => {
  it('drops query string and fragment', () => {
    expect(requestLogPath(`/api/auth/magic-link?token=${TOKEN}#x`)).toBe(
      '/api/auth/magic-link',
    );
    expect(requestLogPath(`/api/public/unsubscribe?t=${TOKEN}`)).toBe(
      '/api/public/unsubscribe',
    );
  });

  it('redacts token segments but keeps UUIDs and short segments', () => {
    expect(requestLogPath(`/api/invitations/${TOKEN}/accept`)).toBe(
      '/api/invitations/:token/accept',
    );
    expect(requestLogPath(`/api/public/shifts/manage/${TOKEN}`)).toBe(
      '/api/public/shifts/manage/:token',
    );
    expect(requestLogPath(`/api/organizations/${UUID}/members`)).toBe(
      `/api/organizations/${UUID}/members`,
    );
    expect(requestLogPath('/api/public/shifts/sommerfest-2026')).toBe(
      '/api/public/shifts/sommerfest-2026',
    );
  });

  it('copes with a missing URL', () => {
    expect(requestLogPath(undefined)).toBe('');
  });
});

describe('LoggingInterceptor', () => {
  function context(url: string) {
    const request = {
      method: 'GET',
      url,
      originalUrl: url,
      ip: '203.0.113.7',
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) SecretBrowser/1.0',
        'x-request-id': 'req-1',
      },
      body: {},
    };
    const response = { statusCode: 200, setHeader: jest.fn() };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  }

  let lines: string[];
  beforeEach(() => {
    lines = [];
    const capture = (message: unknown) => {
      lines.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs method, path, status, duration and request id — no IP, UA or token', async () => {
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    await lastValueFrom(
      new LoggingInterceptor().intercept(
        context(`/api/invitations/${TOKEN}?token=${TOKEN}`),
        handler,
      ),
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[req-1] GET /api/invitations/:token');
    expect(lines[1]).toMatch(
      /^\[req-1\] GET \/api\/invitations\/:token - 200 - \d+ms$/,
    );
    for (const line of lines) {
      expect(line).not.toContain('203.0.113.7');
      expect(line).not.toContain('SecretBrowser');
      expect(line).not.toContain(TOKEN);
      expect(line).not.toMatch(/IP:|UA:/);
    }
  });

  it('keeps errors without the query string', async () => {
    const handler: CallHandler = {
      handle: () => throwError(() => ({ status: 401, message: 'Ungültig' })),
    };
    await expect(
      lastValueFrom(
        new LoggingInterceptor().intercept(
          context(`/api/auth/magic-link/verify?token=${TOKEN}`),
          handler,
        ),
      ),
    ).rejects.toBeDefined();

    expect(lines[lines.length - 1]).toMatch(
      /^\[req-1\] GET \/api\/auth\/magic-link\/verify - 401 - \d+ms - Ungültig$/,
    );
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
