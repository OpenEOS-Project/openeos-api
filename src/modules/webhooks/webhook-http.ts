import * as http from 'http';
import * as https from 'https';
import type { LookupFunction } from 'net';

import type { WebhookDeliveryError } from '../../database/entities/webhook-delivery.entity';
import { RESPONSE_BODY_LIMIT } from './webhooks.config';
import {
  bareHostname,
  checkWebhookUrlSyntax,
  resolveWebhookTarget,
  WebhookTargetError,
  type LookupAll,
} from './webhook-url-guard';

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
}

export interface WebhookResponse {
  ok: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: WebhookDeliveryError | null;
  /** Nur fuers Log (nie an Nutzer): technische Ursache. */
  detail?: string;
}

const TLS_ERROR =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_OSSL_|HOSTNAME_MISMATCH)/;

function classify(error: unknown): {
  error: WebhookDeliveryError;
  detail: string;
} {
  if (error instanceof WebhookTargetError) {
    return { error: error.code, detail: error.message };
  }
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  const message = (error as Error)?.message ?? String(error);
  if (code === 'WEBHOOK_TIMEOUT') return { error: 'TIMEOUT', detail: message };
  if (TLS_ERROR.test(code) || /certificate|ssl|tls/i.test(message)) {
    return { error: 'TLS_FAILED', detail: code || message };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { error: 'DNS_FAILED', detail: code };
  }
  return { error: 'CONNECTION_FAILED', detail: code || message };
}

/**
 * Ein Versuch: POST mit festem Zeitlimit fuer die ganze Antwort, ohne
 * Weiterleitungen, ohne Verbindungs-Pool, mit gepinnter, eben gepruefter
 * Adresse (Schutz vor DNS-Rebinding). TLS wird gegen den Rechnernamen
 * geprueft wie bei jedem Aufruf (SNI und Zertifikat).
 */
export async function sendWebhookRequest(
  request: WebhookRequest,
  lookupAll?: LookupAll,
): Promise<WebhookResponse> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const syntax = checkWebhookUrlSyntax(request.url, request);
  if ('problem' in syntax) {
    return {
      ok: false,
      responseStatus: null,
      responseBody: null,
      durationMs: 0,
      error: 'BLOCKED_ADDRESS',
      detail: `URL rejected: ${syntax.problem}`,
    };
  }
  const url = syntax.url;

  let target: { address: string; family: 4 | 6 };
  try {
    target = await resolveWebhookTarget(bareHostname(url), request, lookupAll);
  } catch (error) {
    return {
      ok: false,
      responseStatus: null,
      responseBody: null,
      durationMs: elapsed(),
      ...classify(error),
    };
  }

  // Immer die gepruefte Adresse — egal, was ein zweiter DNS-Aufruf sagen wuerde.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean })?.all) {
      (
        callback as unknown as (
          err: null,
          addresses: Array<{ address: string; family: number }>,
        ) => void
      )(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };

  const transport = url.protocol === 'http:' ? http : https;
  const body = Buffer.from(request.body, 'utf8');

  return new Promise<WebhookResponse>((resolve) => {
    let settled = false;
    const finish = (result: Omit<WebhookResponse, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: elapsed() });
    };

    const req = transport.request(
      url,
      {
        method: 'POST',
        agent: false,
        lookup: pinned,
        headers: {
          ...request.headers,
          'Content-Length': String(body.length),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          const text = Buffer.concat(chunks)
            .toString('utf8')
            .slice(0, RESPONSE_BODY_LIMIT);
          const ok = status >= 200 && status < 300;
          finish({
            ok,
            responseStatus: status,
            responseBody: text.length > 0 ? text : null,
            error: ok
              ? null
              : status >= 300 && status < 400
                ? 'REDIRECT_NOT_FOLLOWED'
                : 'HTTP_ERROR',
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (size < RESPONSE_BODY_LIMIT * 4) {
            chunks.push(chunk);
            size += chunk.length;
          }
          if (size >= RESPONSE_BODY_LIMIT * 4) {
            // Genug gelesen — der Rest interessiert nicht.
            done();
            res.destroy();
          }
        });
        res.on('end', done);
        res.on('error', done);
        res.on('close', done);
      },
    );

    const timer = setTimeout(() => {
      const error = new Error(
        `No complete response within ${request.timeoutMs} ms`,
      ) as NodeJS.ErrnoException;
      error.code = 'WEBHOOK_TIMEOUT';
      req.destroy(error);
      finish({
        ok: false,
        responseStatus: null,
        responseBody: null,
        ...classify(error),
      });
    }, request.timeoutMs);

    req.on('error', (error) => {
      finish({
        ok: false,
        responseStatus: null,
        responseBody: null,
        ...classify(error),
      });
    });
    req.end(body);
  });
}
