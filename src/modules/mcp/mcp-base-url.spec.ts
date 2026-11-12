import type { Request } from 'express';

import { publicBaseUrl, resourceMetadataUrl } from './mcp.constants';

describe('MCP public base URL', () => {
  const original = process.env.API_PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = original;
  });

  const req = {
    protocol: 'http',
    get: (name: string) => (name === 'host' ? 'other.example' : undefined),
  } as unknown as Request;

  it('uses the configured API URL when set', () => {
    process.env.API_PUBLIC_URL = 'https://api.example.org/';
    expect(publicBaseUrl(req)).toBe('https://api.example.org');
    expect(resourceMetadataUrl(req)).toBe(
      'https://api.example.org/.well-known/oauth-protected-resource',
    );
  });

  it('falls back to the request address without configuration', () => {
    delete process.env.API_PUBLIC_URL;
    expect(publicBaseUrl(req)).toBe('http://other.example');
  });
});
