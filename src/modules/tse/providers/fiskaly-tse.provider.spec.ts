import { FiskalyTseProvider } from './fiskaly-tse.provider';

const config = { apiKey: 'k', apiSecret: 's', tssId: 'tss-1' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

describe('FiskalyTseProvider', () => {
  let provider: FiskalyTseProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    provider = new FiskalyTseProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function mockAuth() {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'jwt-token' }));
  }

  describe('ensureClient', () => {
    it('authenticates then PUTs the client', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({}));

      await provider.ensureClient(config, 'client-1');

      expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/auth'), expect.objectContaining({ method: 'POST' }));
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/tss/tss-1/client/client-1'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  describe('recordTransaction', () => {
    it('starts + finishes a transaction and builds the result from the signature', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ number: 1, time_start: 't0', state: 'ACTIVE' })); // start
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          time_start: 't0',
          time_end: 't1',
          state: 'FINISHED',
          signature: { value: 'sig-val', algorithm: 'ecdsa', public_key: 'pk', counter: 3, time: 1 },
        }),
      ); // finish
      fetchMock.mockResolvedValueOnce(jsonResponse({ serial_number: 'SN-1' })); // GET tss

      const result = await provider.recordTransaction(config, {
        organizationId: 'org-1',
        clientId: 'client-1',
        amount: 12.5,
        currency: 'EUR',
        paymentMethod: 'cash',
      });

      expect(result).toEqual(
        expect.objectContaining({
          provider: 'fiskaly',
          clientId: 'client-1',
          transactionNumber: 7,
          serialNumber: 'SN-1',
          signatureCounter: 3,
          signatureValue: 'sig-val',
          signatureAlgorithm: 'ecdsa',
        }),
      );
    });

    it('throws when the fiskaly response has no signature', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ number: 1, time_start: 't0', state: 'ACTIVE' }));
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ number: 7, time_start: 't0', time_end: 't1', state: 'FINISHED' }), // no signature
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ serial_number: 'SN-1' })); // GET tss (still called before the check)

      await expect(
        provider.recordTransaction(config, {
          organizationId: 'org-1',
          clientId: 'client-1',
          amount: 12.5,
          currency: 'EUR',
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow(/signature/);
    });

    it('propagates a non-ok HTTP response as an error', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'invalid tss' }, false, 400));

      await expect(
        provider.recordTransaction(config, {
          organizationId: 'org-1',
          clientId: 'client-1',
          amount: 12.5,
          currency: 'EUR',
          paymentMethod: 'cash',
        }),
      ).rejects.toThrow(/400/);
    });
  });

  describe('testConnection', () => {
    it('returns ok when the TSS is reachable', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ serial_number: 'SN-1' }));

      const result = await provider.testConnection(config);

      expect(result).toEqual({ ok: true });
    });

    it('returns not-ok with the error message on failure', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 401));

      const result = await provider.testConnection(config);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('401');
    });
  });

  describe('exportData', () => {
    it('creates an export job, polls until DONE, then downloads it', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ _id: 'exp-1', state: 'RUNNING' })); // create
      fetchMock.mockResolvedValueOnce(jsonResponse({ state: 'DONE' })); // poll
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('tar-bytes').buffer,
      }); // download

      const resultPromise = provider.exportData(config, {
        organizationId: 'org-1',
        clientId: 'client-1',
        periodStart: new Date('2026-08-21'),
        periodEnd: new Date('2026-08-23'),
      });

      const result = await resultPromise;

      expect(Buffer.from(result.data).toString()).toBe('tar-bytes');
      expect(result.filename).toContain('client-1');
    }, 15000);

    it('throws when the export job fails', async () => {
      mockAuth();
      fetchMock.mockResolvedValueOnce(jsonResponse({ _id: 'exp-1', state: 'RUNNING' }));
      fetchMock.mockResolvedValueOnce(jsonResponse({ state: 'FAILED' }));

      await expect(
        provider.exportData(config, {
          organizationId: 'org-1',
          clientId: 'client-1',
          periodStart: new Date('2026-08-21'),
          periodEnd: new Date('2026-08-23'),
        }),
      ).rejects.toThrow(/failed/);
    }, 15000);
  });
});
