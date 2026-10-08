import { BadRequestException, Logger } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes';
import { SumUpApiService } from './sumup-api.service';

/** Shape of the SDK's APIError: { status, error (parsed body), response }. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    public error: unknown,
  ) {
    super(`${status} status code`);
  }
}

function serviceFailingWith(error: Error): SumUpApiService {
  const service = new SumUpApiService();
  (service as unknown as { createClient: () => unknown }).createClient =
    () => ({
      readers: { list: () => Promise.reject(error) },
    });
  return service;
}

async function responseOf(error: Error): Promise<Record<string, unknown>> {
  try {
    await serviceFailingWith(error).listReaders('key', 'MERCHANT');
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(BadRequestException);
    return (thrown as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected listReaders to fail');
}

describe('SumUpApiService error mapping', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('reports rejected credentials with their own code', async () => {
    const response = await responseOf(
      new FakeApiError(401, {
        error_code: 'NOT_AUTHORIZED',
        message: 'invalid token',
      }),
    );

    expect(response.code).toBe(ErrorCodes.SUMUP_INVALID_CREDENTIALS);
    expect(response.message).toMatch(/Zugangsdaten/);
    // Fehlertext aus dem Body ({ error_code, message }).
    expect(response.errorType).toBe('NOT_AUTHORIZED');
    expect(response.details).toEqual([
      { code: 'SUMUP_HTTP_401', message: 'invalid token' },
    ]);
  });

  it('treats a forbidden merchant code the same way', async () => {
    const response = await responseOf(new FakeApiError(403, {}));
    expect(response.code).toBe(ErrorCodes.SUMUP_INVALID_CREDENTIALS);
  });

  it('keeps SUMUP_API_ERROR and the SumUp error type for other failures', async () => {
    const response = await responseOf(
      new FakeApiError(422, { errors: { type: 'READER_BUSY' } }),
    );

    expect(response.code).toBe(ErrorCodes.SUMUP_API_ERROR);
    expect(response.message).toBe('READER_BUSY');
    expect(response.details).toEqual([
      { code: 'SUMUP_HTTP_422', message: 'READER_BUSY' },
    ]);
  });

  it('keeps SUMUP_API_ERROR for network errors without a status', async () => {
    const response = await responseOf(new Error('fetch failed'));

    expect(response.code).toBe(ErrorCodes.SUMUP_API_ERROR);
    expect(response.message).toBe('SumUp: fetch failed');
    expect(response.details).toBeUndefined();
  });
});
