import { randomUUID, createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { rename, unlink } from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

import {
  SwissbitError,
  SwissbitTimeoutError,
  SwissbitUnavailableError,
  swissbitErrorFromResponse,
} from './swissbit.errors';

/** Basic-Auth-Paar (Vendor, Credit Token oder TSE). */
export interface BasicAuth {
  user: string;
  password: string;
}

export interface SwissbitRequest {
  /** Name fuer Protokoll und Fehler, z. B. `startTransaction`. */
  operation: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: BasicAuth;
  body?: unknown;
  timeoutMs: number;
  query?: Record<string, string | number>;
}

export interface SwissbitResponse {
  status: number;
  body: unknown;
  requestId: string;
  durationMs: number;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  durationMs: number;
}

export interface SwissbitHttpOptions {
  baseUrl: string;
  /** Hoechstzahl gleichzeitiger Verbindungen zu Swissbit. */
  maxSockets?: number;
  /** Fuer Tests: eigener Agent. */
  agent?: http.Agent;
  /** Protokoll-Hook fuer Fehler (REQUEST-ID, Dauer); nie Zugangsdaten. */
  onError?: (error: SwissbitError) => void;
}

/**
 * HTTP-Schicht fuer Swissbit.
 *
 * - **Keep-Alive**: ein Agent je Basis-URL haelt Verbindungen offen. Swissbit
 *   nennt die Wiederverwendung als wichtigsten Faktor fuer die
 *   Signaturdauer (TLS-Handshake je Aufruf kostet ein Vielfaches).
 * - **REQUEST-ID** (UUIDv4) bei jedem Aufruf; steht in jedem Fehler.
 * - **Zeitlimit** je Aufruf (`timeoutMs`), danach `SwissbitTimeoutError`.
 * - **Tolerantes JSON**: leere Antwort = `null`, kaputtes JSON bei 2xx =
 *   Fehler, bei Fehlerstatus = Status ohne Code.
 */
export class SwissbitHttp {
  readonly baseUrl: URL;
  private readonly agent: http.Agent;
  private readonly onError?: (error: SwissbitError) => void;

  constructor(options: SwissbitHttpOptions) {
    this.baseUrl = new URL(options.baseUrl.replace(/\/+$/, '') + '/');
    const isHttps = this.baseUrl.protocol === 'https:';
    const agentOptions: https.AgentOptions = {
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: options.maxSockets ?? 32,
      maxFreeSockets: Math.min(options.maxSockets ?? 32, 16),
      // Leerlaufende Verbindungen nach 60 s schliessen (Swissbit-Seite
      // schliesst sonst irgendwann selbst, dann gaebe es ECONNRESET).
      timeout: 60_000,
      scheduling: 'lifo',
    };
    this.agent =
      options.agent ??
      (isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions));
    this.onError = options.onError;
  }

  /** Schliesst offene Verbindungen (Herunterfahren, Tests). */
  destroy(): void {
    this.agent.destroy();
  }

  async request(req: SwissbitRequest): Promise<SwissbitResponse> {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      return await this.send(req, requestId, started);
    } catch (error) {
      const wrapped =
        error instanceof SwissbitError
          ? error
          : new SwissbitUnavailableError({
              operation: req.operation,
              status: null,
              errorCode: 'E_NETWORK',
              message: error instanceof Error ? error.message : String(error),
              requestId,
              durationMs: Date.now() - started,
            });
      this.onError?.(wrapped);
      throw wrapped;
    }
  }

  private send(
    req: SwissbitRequest,
    requestId: string,
    started: number,
  ): Promise<SwissbitResponse> {
    const url = new URL(req.path.replace(/^\/+/, ''), this.baseUrl);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const payload =
      req.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(req.body));
    const headers: http.OutgoingHttpHeaders = {
      Accept: 'application/json',
      Authorization:
        'Basic ' +
        Buffer.from(`${req.auth.user}:${req.auth.password}`).toString('base64'),
      'REQUEST-ID': requestId,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise<SwissbitResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const request = transport.request(
        url,
        { method: req.method, headers, agent: this.agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', (error) => finish(() => reject(error)));
          res.on('end', () =>
            finish(() => {
              const durationMs = Date.now() - started;
              const status = res.statusCode ?? 0;
              const text = Buffer.concat(chunks).toString('utf8');
              let body: unknown = null;
              let parseFailed = false;
              if (text.trim()) {
                try {
                  body = JSON.parse(text);
                } catch {
                  parseFailed = true;
                }
              }
              if (status >= 200 && status < 300) {
                if (parseFailed) {
                  reject(
                    new SwissbitError({
                      operation: req.operation,
                      status,
                      errorCode: 'E_UNEXPECTED_RESPONSE',
                      message: 'response is not valid JSON',
                      requestId,
                      durationMs,
                    }),
                  );
                  return;
                }
                resolve({ status, body, requestId, durationMs });
                return;
              }
              reject(
                swissbitErrorFromResponse({
                  operation: req.operation,
                  status,
                  requestId,
                  durationMs,
                  body,
                }),
              );
            }),
          );
        },
      );
      const timer = setTimeout(() => {
        finish(() => {
          request.destroy();
          reject(
            new SwissbitTimeoutError({
              operation: req.operation,
              status: null,
              errorCode: 'E_TIMEOUT',
              message: `no response within ${req.timeoutMs} ms`,
              requestId,
              durationMs: Date.now() - started,
            }),
          );
        });
      }, req.timeoutMs);
      request.on('error', (error) => finish(() => reject(error)));
      if (payload) request.write(payload);
      request.end();
    });
  }

  /**
   * Laedt eine Datei (oeffentliche Export-URL, ohne Zugangsdaten) in
   * `targetPath` und berechnet dabei SHA-256. Schreibt erst in eine
   * `.part`-Datei und benennt sie nach vollstaendigem Download um.
   */
  async download(
    downloadUrl: string,
    targetPath: string,
    timeoutMs: number,
    redirectsLeft = 3,
  ): Promise<DownloadResult> {
    const started = Date.now();
    const url = new URL(downloadUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const partPath = `${targetPath}.part`;

    const result = await new Promise<{ sha256: string; sizeBytes: number }>(
      (resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.destroy();
          reject(error);
        };
        const request = transport.get(url, (res) => {
          const status = res.statusCode ?? 0;
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            settled = true;
            clearTimeout(timer);
            this.download(
              new URL(res.headers.location, url).toString(),
              targetPath,
              timeoutMs,
              redirectsLeft - 1,
            ).then(
              (r) => resolve({ sha256: r.sha256, sizeBytes: r.sizeBytes }),
              reject,
            );
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            fail(new Error(`download failed with HTTP ${status}`));
            return;
          }
          const hash = createHash('sha256');
          let size = 0;
          const out = createWriteStream(partPath, { mode: 0o600 });
          res.on('data', (chunk: Buffer) => {
            hash.update(chunk);
            size += chunk.length;
          });
          res.on('error', fail);
          out.on('error', fail);
          out.on('finish', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ sha256: hash.digest('hex'), sizeBytes: size });
          });
          res.pipe(out);
        });
        request.on('error', fail);
        const timer = setTimeout(
          () => fail(new Error(`download timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      },
    ).catch(async (error: unknown) => {
      await unlink(partPath).catch(() => undefined);
      throw error;
    });

    // Bei einer Weiterleitung hat der innere Aufruf schon umbenannt.
    await rename(partPath, targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return { path: targetPath, ...result, durationMs: Date.now() - started };
  }
}
