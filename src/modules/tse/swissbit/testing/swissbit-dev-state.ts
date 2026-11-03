import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { SwissbitClient } from '../swissbit.client';
import { SwissbitNotFoundError, SwissbitAuthError } from '../swissbit.errors';
import type { TseCredentials } from '../swissbit.types';

/**
 * Gemeinsamer Zustand fuer Tests gegen die Swissbit-Entwicklungsumgebung
 * (https://dev.web-tse.de).
 *
 * Die Dev-Umgebung erlaubt systemweit nur 200 TSEs fuer alle Kunden und
 * wird regelmaessig geleert. Deshalb: hoechstens EIN Credit Token und
 * hoechstens DREI TSEs insgesamt; einmal angelegte TSEs werden ueber alle
 * Testlaeufe wiederverwendet. Der Zustand liegt ausserhalb des Repos in
 * `~/.config/openeos/swissbit-dev-state.json` (chmod 600, nie committen).
 */
export const DEV_STATE_PATH =
  process.env.SWISSBIT_DEV_STATE ??
  join(homedir(), '.config', 'openeos', 'swissbit-dev-state.json');

export const DEV_ENV_PATH =
  process.env.SWISSBIT_DEV_ENV ??
  join(homedir(), '.config', 'openeos', 'swissbit-dev.env');

export const MAX_DEV_TSES = 3;

export interface DevTse {
  serialNumber: string;
  accessToken: string;
  productType: string;
  createdAt: string;
  clientIds: string[];
  wiped?: boolean;
}

export interface DevState {
  baseUrl: string;
  creditToken: { clientId: string; secret: string; createdAt: string };
  productType: string;
  tses: DevTse[];
  tsesCreatedTotal: number;
  notes?: string;
}

export function loadDevEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(DEV_ENV_PATH)) return env;
  for (const line of readFileSync(DEV_ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    env[trimmed.slice(0, index)] = trimmed
      .slice(index + 1)
      .replace(/^["']|["']$/g, '');
  }
  return env;
}

export function loadDevState(): DevState {
  return JSON.parse(readFileSync(DEV_STATE_PATH, 'utf8')) as DevState;
}

export function saveDevState(state: DevState): void {
  writeFileSync(DEV_STATE_PATH, JSON.stringify(state, null, 1), {
    mode: 0o600,
  });
  chmodSync(DEV_STATE_PATH, 0o600);
}

export function devClient(state: DevState): SwissbitClient {
  const env = loadDevEnv();
  return new SwissbitClient({
    baseUrl: state.baseUrl,
    vendor: env.SWISSBIT_VENDOR_CLIENT
      ? {
          client: env.SWISSBIT_VENDOR_CLIENT,
          secret: env.SWISSBIT_VENDOR_SECRET,
        }
      : null,
    timeouts: { transactionMs: 10_000, adminMs: 20_000 },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Liefert eine nutzbare Dev-TSE: die erste gespeicherte, die noch antwortet;
 * sonst wird — innerhalb des Limits — eine neue angelegt und SOFORT
 * gespeichert (das Access Token gibt Swissbit nur einmal heraus).
 */
export async function ensureDevTse(
  client: SwissbitClient,
  state: DevState,
): Promise<{ tse: TseCredentials; entry: DevTse }> {
  for (const entry of state.tses.filter((t) => !t.wiped)) {
    const tse = {
      serialNumber: entry.serialNumber,
      accessToken: entry.accessToken,
    };
    try {
      const info = await client.info(tse);
      if (info.value.initializationState !== 'disabled') {
        return { tse, entry };
      }
      entry.wiped = true;
    } catch (error) {
      if (
        error instanceof SwissbitAuthError ||
        error instanceof SwissbitNotFoundError
      ) {
        entry.wiped = true; // Umgebung wurde geleert
      } else {
        throw error;
      }
    }
  }
  saveDevState(state);

  if (state.tsesCreatedTotal >= MAX_DEV_TSES) {
    throw new Error(
      `Dev TSE limit reached (${MAX_DEV_TSES} created in total). Not creating another one.`,
    );
  }
  const credit = {
    clientId: state.creditToken.clientId,
    secret: state.creditToken.secret,
  };
  const created = await client.createTse(credit, {
    productType: state.productType,
    metadata: JSON.stringify({ purpose: 'openeos-dev-integration-tests' }),
  });
  state.tsesCreatedTotal += 1;
  saveDevState(state);

  for (let attempt = 0; attempt < 36; attempt++) {
    await sleep(5_000);
    const status = await client.creationStatus(
      credit,
      created.value.creationId,
    );
    if (status.value.status === 'pending') continue;
    if (
      status.value.status !== 'success' ||
      !status.value.tseSerialNumber ||
      !status.value.tseAccessToken
    ) {
      throw new Error(
        `TSE creation failed: ${status.value.errorCode ?? ''} ${status.value.errorMessage ?? ''}`,
      );
    }
    const entry: DevTse = {
      serialNumber: status.value.tseSerialNumber,
      accessToken: status.value.tseAccessToken,
      productType: state.productType,
      createdAt: new Date().toISOString(),
      clientIds: [],
    };
    state.tses.push(entry);
    saveDevState(state);
    return {
      tse: { serialNumber: entry.serialNumber, accessToken: entry.accessToken },
      entry,
    };
  }
  throw new Error('TSE creation did not finish within 3 minutes');
}
