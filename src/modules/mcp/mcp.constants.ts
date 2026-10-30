import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Request } from 'express';

export const MCP_PATH = 'mcp';
export const PROTECTED_RESOURCE_PATH = '.well-known/oauth-protected-resource';
export const MCP_SERVER_NAME = 'openeos';

/** Version aus package.json — gilt in `src/` wie in `dist/`. */
export const MCP_SERVER_VERSION = readPackageVersion();

function readPackageVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'openeos-api' && parsed.version) return parsed.version;
    } catch {
      // weiter nach oben
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/** Oeffentliche Basis-URL dieser Installation, so wie der Client sie sieht. */
export function publicBaseUrl(req: Request): string {
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}

export function resourceMetadataUrl(req: Request): string {
  return `${publicBaseUrl(req)}/${PROTECTED_RESOURCE_PATH}`;
}
