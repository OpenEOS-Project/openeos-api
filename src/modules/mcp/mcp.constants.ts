import type { Request } from 'express';

export const MCP_PATH = 'mcp';
export const PROTECTED_RESOURCE_PATH = '.well-known/oauth-protected-resource';
export const MCP_SERVER_NAME = 'openeos';

/**
 * Oeffentliche Basis-URL dieser Installation. Ist API_PUBLIC_URL gesetzt,
 * gilt immer dieser Wert; nur ohne Konfiguration (lokale Entwicklung,
 * Tests) faellt sie auf die Adresse der Anfrage zurueck.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}
export function resourceMetadataUrl(req: Request): string {
  return `${publicBaseUrl(req)}/${PROTECTED_RESOURCE_PATH}`;
}
