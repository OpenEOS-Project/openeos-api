import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { ORGANIZATION_TOKEN_SCOPES } from '../api-tokens/api-scopes';
import { MCP_PATH, publicBaseUrl } from './mcp.constants';

/**
 * Metadaten der geschuetzten Ressource (RFC 9728) fuer MCP-Clients.
 *
 * Phase 2: nur Bearer-Tokens im Header, keine Autorisierungsserver —
 * ein Client, der OAuth erwartet, sieht hier, dass es (noch) keinen gibt,
 * und laesst den Nutzer einen API-Token eintragen. Phase 3 ergaenzt
 * `authorization_servers`.
 *
 * Direkt ueber `res.json`, damit die Antwort nicht in `{ data }`
 * verpackt wird — der RFC verlangt das nackte Objekt.
 */
@ApiExcludeController()
@Public()
@Controller('.well-known')
export class OAuthProtectedResourceController {
  @Get('oauth-protected-resource')
  metadata(@Req() req: Request, @Res() res: Response): void {
    res.json(protectedResourceMetadata(publicBaseUrl(req)));
  }
}

export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/${MCP_PATH}`,
    resource_name: 'OpenEOS MCP',
    bearer_methods_supported: ['header'],
    scopes_supported: [...ORGANIZATION_TOKEN_SCOPES],
    resource_documentation:
      'https://github.com/OpenEOS-Project/openeos-api#mcp',
  };
}
