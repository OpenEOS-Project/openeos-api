import { BadRequestException, Logger } from '@nestjs/common';
import { ErrorCodes } from '../../common/constants/error-codes';
import { SumUpApiService } from './sumup-api.service';

/** Shape of the SDK's APIError: { status, error (parsed body) }. */
class FakeApiError extends Error {
  constructor(
    public status: number,
    public error: unknown,
  ) {
    super(`${status} status code`);
  }
}

function withClient(client: unknown): SumUpApiService {
  const service = new SumUpApiService();
  (service as unknown as { createClient: () => unknown }).createClient = () =>
    client;
  return service;
}

describe('SumUpApiService.refundTransaction (SumUp mock)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('resolves the transaction from the client_transaction_id and refunds the amount', async () => {
    const get = jest.fn(() =>
      Promise.resolve({ id: 'txn-1', transaction_code: 'TCODE' }),
    );
    const refund = jest.fn(() => Promise.resolve());
    const service = withClient({ transactions: { get, refund } });

    const result = await service.refundTransaction(
      'sup_sk_x',
      'MCODE',
      'client-uuid',
      4.5,
    );

    expect(get).toHaveBeenCalledWith('MCODE', {
      client_transaction_id: 'client-uuid',
    });
    // POST /v0.1/me/refund/{txn_id} mit { amount } in Euro
    expect(refund).toHaveBeenCalledWith('txn-1', { amount: 4.5 });
    expect(result).toEqual({
      transactionId: 'txn-1',
      transactionCode: 'TCODE',
    });
  });

  it('falls back to the transaction id when the client id is unknown', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(new FakeApiError(404, {}))
      .mockResolvedValueOnce({ id: 'txn-2' });
    const refund = jest.fn(() => Promise.resolve());
    const service = withClient({ transactions: { get, refund } });

    await service.refundTransaction('k', 'M', 'txn-2', 1);

    expect(get).toHaveBeenLastCalledWith('M', { id: 'txn-2' });
    expect(refund).toHaveBeenCalledWith('txn-2', { amount: 1 });
  });

  it('rounds the amount to cents', async () => {
    const refund = jest.fn(() => Promise.resolve());
    const service = withClient({
      transactions: { get: () => Promise.resolve({ id: 't' }), refund },
    });
    await service.refundTransaction('k', 'M', 'c', 1.005 + 2);
    expect(refund).toHaveBeenCalledWith('t', { amount: 3.01 });
  });

  it.each([
    [409, { detail: 'The transaction is not refundable in its current state' }],
    [
      422,
      {
        detail: 'Refund failed.',
        errors: [
          {
            code: 'INVALID_AMOUNT',
            detail: 'Amount exceeds the refundable amount',
          },
        ],
      },
    ],
    [
      400,
      [{ error_code: 'INVALID', message: 'amount must be greater than zero' }],
    ],
  ])(
    'maps a SumUp %s to SUMUP_API_ERROR with the upstream status',
    async (status, body) => {
      const service = withClient({
        transactions: {
          get: () => Promise.resolve({ id: 't' }),
          refund: () => Promise.reject(new FakeApiError(status, body)),
        },
      });
      try {
        await service.refundTransaction('k', 'M', 'c', 2);
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse() as {
          code: string;
          details: { code: string; message: string }[];
        };
        expect(response.code).toBe(ErrorCodes.SUMUP_API_ERROR);
        expect(response.details[0].code).toBe(`SUMUP_HTTP_${status}`);
        expect(response.details[0].message).toBeTruthy();
      }
    },
  );

  it('reports invalid credentials separately', async () => {
    const service = withClient({
      transactions: {
        get: () => Promise.reject(new FakeApiError(401, {})),
        refund: jest.fn(),
      },
    });
    await expect(
      service.refundTransaction('k', 'M', 'c', 2),
    ).rejects.toMatchObject({
      response: { code: ErrorCodes.SUMUP_INVALID_CREDENTIALS },
    });
  });
});
