import type { Request } from 'express';

export const MCP_PATH = 'mcp';
export const PROTECTED_RESOURCE_PATH = '.well-known/oauth-protected-resource';
export const MCP_SERVER_NAME = 'openeos';

/** Oeffentliche Basis-URL dieser Installation, so wie der Client sie sieht. */
export function publicBaseUrl(req: Request): string {
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}

export function resourceMetadataUrl(req: Request): string {
  return `${publicBaseUrl(req)}/${PROTECTED_RESOURCE_PATH}`;
}
