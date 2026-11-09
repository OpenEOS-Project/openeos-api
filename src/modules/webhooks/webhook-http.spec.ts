import * as http from 'http';
import type { AddressInfo } from 'net';

import { sendWebhookRequest, type WebhookRequest } from './webhook-http';
import type { LookupAll } from './webhook-url-guard';

/**
 * Der Sender gegen echte lokale HTTP-Server (127.0.0.1, daher mit
 * `allowPrivateNetworks` und `allowHttp` — wie eine eigene Installation im
 * LAN). Geprueft: Erfolg, gekuerzte Antwort, keine Weiterleitung, Zeitlimit,
 * Sperre privater Ziele, gepinnte Adresse.
 */
describe('sendWebhookRequest', () => {
  let server: http.Server;
  let port: number;
  const hits: {
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', headers: req.headers, body });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    };
  });

  const request = (
    overrides: Partial<WebhookRequest> = {},
  ): WebhookRequest => ({
    url: `http://127.0.0.1:${port}/hook`,
    body: '{"id":"evt_1"}',
    headers: {
      'Content-Type': 'application/json',
      'OpenEOS-Event-Id': 'evt_1',
    },
    timeoutMs: 2_000,
    allowHttp: true,
    allowPrivateNetworks: true,
    ...overrides,
  });

  it('POSTs the body with the headers and reports 2xx as success', async () => {
    const result = await sendWebhookRequest(request());
    expect(result).toMatchObject({
      ok: true,
      responseStatus: 200,
      responseBody: 'ok',
      error: null,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toBe('{"id":"evt_1"}');
    expect(hits[0].headers['openeos-event-id']).toBe('evt_1');
    expect(hits[0].headers['content-length']).toBe('14');
  });

  it('keeps at most 1 KB of the response', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(10_000));
    };
    const result = await sendWebhookRequest(request());
    expect(result.ok).toBe(true);
    expect(result.responseBody).toHaveLength(1024);
  });

  it('treats non-2xx as HTTP_ERROR', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };
    await expect(sendWebhookRequest(request())).resolves.toMatchObject({
      ok: false,
      responseStatus: 500,
      responseBody: 'boom',
      error: 'HTTP_ERROR',
    });
  });

  it('does not follow redirects (no request to the Location)', async () => {
    handler = (req, res) => {
      if (req.url === '/hook') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('followed');
    };
    const result = await sendWebhookRequest(request());
    expect(result).toMatchObject({
      ok: false,
      responseStatus: 302,
      error: 'REDIRECT_NOT_FOLLOWED',
    });
    expect(hits.map((h) => h.url)).toEqual(['/hook']);
  });

  it('gives up after the timeout', async () => {
    handler = () => undefined; // antwortet nie
    const result = await sendWebhookRequest(request({ timeoutMs: 1_000 }));
    expect(result).toMatchObject({
      ok: false,
      responseStatus: null,
      error: 'TIMEOUT',
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it('refuses private targets without WEBHOOKS_ALLOW_PRIVATE_NETWORKS (no connection)', async () => {
    const result = await sendWebhookRequest(
      request({ allowPrivateNetworks: false }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'BLOCKED_ADDRESS',
      responseStatus: null,
    });
    expect(hits).toHaveLength(0);
  });

  it('refuses http:// without WEBHOOKS_ALLOW_HTTP', async () => {
    const result = await sendWebhookRequest(request({ allowHttp: false }));
    expect(result).toMatchObject({ ok: false, error: 'BLOCKED_ADDRESS' });
    expect(hits).toHaveLength(0);
  });

  it('blocks a name that resolves to a private address at send time (DNS rebinding)', async () => {
    const rebinding: LookupAll = () =>
      Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    const result = await sendWebhookRequest(
      request({
        url: `http://rebind.example.org:${port}/hook`,
        allowPrivateNetworks: false,
      }),
      rebinding,
    );
    expect(result).toMatchObject({ ok: false, error: 'BLOCKED_ADDRESS' });
    expect(hits).toHaveLength(0);
  });

  it('connects to exactly the checked address (pinned lookup, Host header kept)', async () => {
    let calls = 0;
    const once: LookupAll = () => {
      calls += 1;
      return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    };
    const result = await sendWebhookRequest(
      request({ url: `http://receiver.example.test:${port}/hook` }),
      once,
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(1); // kein zweiter DNS-Aufruf beim Verbinden
    expect(hits[0].headers.host).toBe(`receiver.example.test:${port}`);
  });

  it('reports refused connections as CONNECTION_FAILED', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(
      sendWebhookRequest(request({ url: `http://127.0.0.1:${closedPort}/` })),
    ).resolves.toMatchObject({ ok: false, error: 'CONNECTION_FAILED' });
  });
});
