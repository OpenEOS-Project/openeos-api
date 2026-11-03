import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { AddressInfo, Socket } from 'net';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

import { SwissbitClient } from './swissbit.client';
import {
  SwissbitAuthError,
  SwissbitNotFoundError,
  SwissbitRequestError,
  SwissbitTimeoutError,
  SwissbitUnavailableError,
  SwissbitValidationError,
} from './swissbit.errors';

type Handler = (
  req: IncomingMessage,
  body: string,
  res: ServerResponse,
) => void;

const TSE = { serialNumber: 'abc123', accessToken: 'secret-token' };
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('SwissbitClient (HTTP contract)', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  const requests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }> = [];
  const sockets = new Set<Socket>();
  let client: SwissbitClient;

  beforeAll(async () => {
    server = createServer((req, res) => {
      sockets.add(req.socket);
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        handler(req, body, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    sockets.clear();
    client?.destroy();
    client = new SwissbitClient({
      baseUrl,
      vendor: { client: 'vendor', secret: 'vsecret' },
      timeouts: { transactionMs: 300, adminMs: 300 },
    });
  });

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'REQUEST-ID': 'echo',
    });
    res.end(JSON.stringify(body));
  }

  it('sends REQUEST-ID (UUIDv4), Basic auth and Base64 process data; ignores unknown fields', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        transactionNumber: 7,
        signatureCreationTime: 1793716174,
        signatureCounter: 42,
        signatureValue: 'c2ln',
        someNewField: { nested: true },
      });
    const result = await client.startTransaction(TSE, {
      clientId: 'OEOS-1',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^1.19_0.00_0.00_0.00_0.00^1.19:Bar',
    });
    expect(result.value).toEqual({
      transactionNumber: 7,
      signatureCreationTime: 1793716174,
      signatureCounter: 42,
      signatureValue: 'c2ln',
    });
    const [req] = requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/tse/startTransaction');
    expect(req.headers['request-id']).toMatch(UUID_V4);
    expect(result.requestId).toBe(req.headers['request-id']);
    expect(req.headers.authorization).toBe(
      'Basic ' + Buffer.from('abc123:secret-token').toString('base64'),
    );
    const body = JSON.parse(req.body) as Record<string, string>;
    expect(Buffer.from(body.processData, 'base64').toString()).toBe(
      'Beleg^1.19_0.00_0.00_0.00_0.00^1.19:Bar',
    );
    expect(body).not.toHaveProperty('transactionNumber');
  });

  it('sends the transaction number on finish', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, {
        transactionNumber: 7,
        signatureCreationTime: 1,
        signatureCounter: 2,
        signatureValue: 'x',
      });
    await client.finishTransaction(TSE, 7, {
      clientId: 'C',
      processType: 'Kassenbeleg-V1',
      processData: 'x',
    });
    expect(JSON.parse(requests[0].body)).toMatchObject({
      transactionNumber: 7,
      clientId: 'C',
    });
  });

  it('uses a fresh REQUEST-ID per call and reuses the connection (keep-alive)', async () => {
    handler = (_req, _body, res) => json(res, 200, ['OEOS-1']);
    await client.listClients(TSE);
    await client.listClients(TSE);
    await client.listClients(TSE);
    const ids = requests.map((r) => r.headers['request-id']);
    expect(new Set(ids).size).toBe(3);
    expect(sockets.size).toBe(1);
    expect(requests[0].headers.connection).toBe('keep-alive');
  });

  it.each([
    [
      400,
      { errorCode: 'E_CLIENT_NOT_REGISTERED', errorMessage: 'nope' },
      SwissbitRequestError,
      'E_CLIENT_NOT_REGISTERED',
      false,
    ],
    [
      401,
      { errorCode: 'E_AUTH_FAILED', errorMessage: 'bad' },
      SwissbitAuthError,
      'E_AUTH_FAILED',
      false,
    ],
    [
      404,
      { errorCode: 'E_JOB_NOT_FOUND', errorMessage: 'gone' },
      SwissbitNotFoundError,
      'E_JOB_NOT_FOUND',
      false,
    ],
    [
      422,
      [{ loc: ['body', 'clientId'], msg: 'field required', type_: 'x' }],
      SwissbitValidationError,
      'E_VALIDATION',
      false,
    ],
    [
      429,
      { errorCode: 'E_TSE_TOO_MANY_REQUESTS', errorMessage: 'slow' },
      SwissbitUnavailableError,
      'E_TSE_TOO_MANY_REQUESTS',
      true,
    ],
    [
      503,
      { errorCode: 'E_MAINTENANCE_IN_PROGRESS', errorMessage: 'wait' },
      SwissbitUnavailableError,
      'E_MAINTENANCE_IN_PROGRESS',
      true,
    ],
    [
      503,
      { errorCode: 'E_TSE_DEFECT', errorMessage: 'broken' },
      SwissbitUnavailableError,
      'E_TSE_DEFECT',
      false,
    ],
    [500, 'not json', SwissbitUnavailableError, 'E_UNEXPECTED_RESPONSE', true],
  ])(
    'maps HTTP %d to a typed error',
    async (status, body, type, code, retryable) => {
      handler = (_req, _b, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const error = await client
        .registerClient(TSE, 'OEOS-1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ errorCode: code, status, retryable });
      expect((error as { requestId: string }).requestId).toMatch(UUID_V4);
      expect((error as Error).message).toContain('REQUEST-ID');
      expect((error as Error).message).not.toContain('secret-token');
    },
  );

  it('times out with SwissbitTimeoutError', async () => {
    handler = () => undefined; // never answers
    const started = Date.now();
    const error = await client
      .startTransaction(
        TSE,
        { clientId: 'C', processType: 'Kassenbeleg-V1', processData: '' },
        150,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwissbitTimeoutError);
    expect(error).toMatchObject({ errorCode: 'E_TIMEOUT', status: null });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reports a malformed 2xx answer as E_UNEXPECTED_RESPONSE', async () => {
    handler = (_req, _b, res) => json(res, 200, { transactionNumber: 'abc' });
    await expect(
      client.startTransaction(TSE, {
        clientId: 'C',
        processType: 'P',
        processData: '',
      }),
    ).rejects.toMatchObject({ errorCode: 'E_UNEXPECTED_RESPONSE' });
  });

  it('parses enum values in either form (pending / AsyncJobStatus.success)', async () => {
    handler = (_req, _b, res) =>
      json(res, 200, {
        status: 'AsyncJobStatus.success',
        tseSerialNumber: 'ff',
        tseAccessToken: 'tok',
        errorCode: '',
        errorMessage: '',
      });
    const status = await client.creationStatus(
      { clientId: 'c', secret: 's' },
      'job-1',
    );
    expect(status.value).toEqual({
      status: 'success',
      tseSerialNumber: 'ff',
      tseAccessToken: 'tok',
      errorCode: null,
      errorMessage: null,
    });
    expect(requests[0].url).toBe('/api/v1/tses/job-1');
    expect(requests[0].headers.authorization).toBe(
      'Basic ' + Buffer.from('c:s').toString('base64'),
    );
  });

  it('uses vendor credentials for the Billing API and passes query parameters', async () => {
    handler = (_req, _b, res) =>
      json(res, 200, {
        createdTses: [{ tseSerialNumber: 'a', productType: '850007' }],
        activeTses: [
          { tseSerialNumber: 'a', productType: '850007', autoTopUps: null },
        ],
        deactivatedTses: [],
      });
    const report = await client.usageReport('credit-1', 2026, 11);
    expect(report.value.activeTses).toHaveLength(1);
    expect(requests[0].url).toBe(
      '/api/v1/creditTokens/credit-1/usage?year=2026&month=11',
    );
    expect(requests[0].headers.authorization).toBe(
      'Basic ' + Buffer.from('vendor:vsecret').toString('base64'),
    );
  });

  it('downloads an export with SHA-256 and keeps no partial file on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swissbit-dl-'));
    try {
      const payload = Buffer.alloc(1024, 7);
      handler = (req, _b, res) => {
        if (req.url === '/file.tar') {
          res.writeHead(200);
          res.end(payload);
        } else {
          res.writeHead(500);
          res.end();
        }
      };
      const target = join(dir, 'export.tar');
      const result = await client.downloadExport(`${baseUrl}/file.tar`, target);
      expect(result.sizeBytes).toBe(1024);
      expect(result.sha256).toBe(
        createHash('sha256').update(payload).digest('hex'),
      );
      expect(readFileSync(target)).toEqual(payload);

      const failed = join(dir, 'broken.tar');
      await expect(
        client.downloadExport(`${baseUrl}/broken`, failed),
      ).rejects.toThrow('HTTP 500');
      expect(() => readFileSync(`${failed}.part`)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
