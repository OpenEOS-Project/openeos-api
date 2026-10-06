import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ValidationError } from 'class-validator';
import {
  HttpExceptionFilter,
  type ErrorResponse,
} from './http-exception.filter';
import { ErrorCodes, ErrorReasons } from '../constants/error-codes';
import { validationException } from '../pipes/validation.pipe';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn(),
  captureException: jest.fn(),
}));

function run(
  exception: unknown,
  requestOverrides: Record<string, unknown> = {},
): { status: number; body: ErrorResponse } {
  const result = { status: 0, body: undefined as unknown as ErrorResponse };
  const response = {
    getHeader: () => undefined,
    status: (code: number) => {
      result.status = code;
      return response;
    },
    json: (body: ErrorResponse) => {
      result.body = body;
      return response;
    },
  };
  const request = {
    headers: { 'x-request-id': 'req-1' },
    method: 'GET',
    url: '/api/test',
    ip: '127.0.0.1',
    ...requestOverrides,
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  const filter = new HttpExceptionFilter();
  // keine Log-Ausgabe im Testlauf
  (
    filter as unknown as { logger: { warn: () => void; error: () => void } }
  ).logger = {
    warn: () => undefined,
    error: () => undefined,
  };
  filter.catch(exception, host);
  return result;
}

describe('HttpExceptionFilter', () => {
  it('passes code, reason, message and params through', () => {
    const { status, body } = run(
      new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SHIFT_FULL,
        message: 'Schicht „Theke“ ist bereits voll belegt',
        params: { shift: 'Theke' },
      }),
    );

    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      reason: 'SHIFT_FULL',
      message: 'Schicht „Theke“ ist bereits voll belegt',
      params: { shift: 'Theke' },
      requestId: 'req-1',
    });
  });

  it('leaves reason and params out when the exception has none', () => {
    const { body } = run(
      new NotFoundException({
        code: ErrorCodes.EVENT_NOT_PAID,
        message: 'Veranstaltung ist noch nicht freigeschaltet',
      }),
    );

    expect(body.error.code).toBe('EVENT_NOT_PAID');
    expect(body.error).not.toHaveProperty('reason');
    expect(body.error).not.toHaveProperty('params');
  });

  it('keeps only primitive params', () => {
    const { body } = run(
      new ForbiddenException({
        code: ErrorCodes.TEST_LIMIT_REACHED,
        message: 'Test-Limit erreicht',
        params: { maxOrders: 20, nested: { a: 1 }, list: [1], ok: true },
      }),
    );

    expect(body.error.params).toEqual({ maxOrders: 20, ok: true });
  });

  it('maps a plain string exception to the status code', () => {
    const { status, body } = run(new UnauthorizedException('Nope'));

    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Nope' });
  });

  it('keeps upstream details (SumUp)', () => {
    const { body } = run(
      new BadRequestException({
        code: ErrorCodes.SUMUP_INVALID_CREDENTIALS,
        message: 'SumUp hat die Zugangsdaten abgelehnt.',
        details: [{ code: 'SUMUP_HTTP_401', message: 'invalid token' }],
      }),
    );

    expect(body.error.code).toBe('SUMUP_INVALID_CREDENTIALS');
    expect(body.error.details).toEqual([
      { code: 'SUMUP_HTTP_401', message: 'invalid token' },
    ]);
  });

  it('turns the built-in ValidationPipe message array into details', () => {
    const { body } = run(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email'],
      }),
    );

    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validierung fehlgeschlagen',
      details: [{ message: 'email must be an email' }],
    });
  });

  it('reports field and constraint code for validation errors', () => {
    const child = Object.assign(new ValidationError(), {
      property: 'quantity',
      constraints: { min: 'quantity must not be less than 1' },
      children: [],
    });
    const errors = [
      Object.assign(new ValidationError(), {
        property: 'email',
        constraints: {
          isEmail: 'Ungültige E-Mail-Adresse',
          isNotEmpty: 'E-Mail ist erforderlich',
        },
        children: [],
      }),
      Object.assign(new ValidationError(), {
        property: 'items',
        children: [
          Object.assign(new ValidationError(), {
            property: '0',
            children: [child],
          }),
        ],
      }),
    ];

    const { status, body } = run(validationException(errors));

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([
      {
        field: 'email',
        code: 'INVALID_EMAIL',
        message: 'Ungültige E-Mail-Adresse',
      },
      { field: 'email', code: 'REQUIRED', message: 'E-Mail ist erforderlich' },
      {
        field: 'items.0.quantity',
        code: 'TOO_SMALL',
        message: 'quantity must not be less than 1',
      },
    ]);
  });

  it('does not leak messages of unexpected errors', () => {
    const { status, body } = run(new Error('db password wrong'));

    expect(status).toBe(500);
    expect(body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Interner Serverfehler',
    });
  });
});

describe('HttpExceptionFilter error reports', () => {
  it('reports 5xx errors with user id only and without query string', () => {
    const scope = { setTag: jest.fn(), setUser: jest.fn() };
    (Sentry.withScope as unknown as jest.Mock).mockImplementation(
      (callback: (s: typeof scope) => void) => callback(scope),
    );

    run(new Error('boom'), {
      url: '/api/orders?token=secret',
      user: { id: 'user-1', email: 'person@example.org' },
    });

    expect(scope.setUser).toHaveBeenCalledWith({ id: 'user-1' });
    expect(scope.setTag).toHaveBeenCalledWith('url', '/api/orders');
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
