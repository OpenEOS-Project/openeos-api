import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { ApiTokenThrottlerGuard } from '../../common/guards/api-token-throttler.guard';
import type { AppRequest } from '../../common/types/request.types';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpServerFactory } from './mcp-server.factory';
import { MCP_PATH } from './mcp.constants';

/**
 * MCP-Endpunkt (Streamable HTTP, zustandslos) ausserhalb von `/api`.
 *
 * `@Public()` nimmt den Endpunkt aus dem JwtAuthGuard heraus; angemeldet
 * wird mit dem McpAuthGuard (nur API-Tokens). Danach zaehlt der
 * ApiTokenThrottlerGuard denselben Zaehler wie bei REST-Aufrufen mit
 * diesem Token (120/min, 5.000/Tag).
 *
 * Je Anfrage ein neuer Server und Transport: keine Sitzung, nichts im
 * Speicher, jede Instanz kann jede Anfrage beantworten.
 */
@ApiExcludeController()
@Public()
@UseGuards(McpAuthGuard, ApiTokenThrottlerGuard)
@Controller(MCP_PATH)
export class McpController {
  constructor(private readonly factory: McpServerFactory) {}

  @Post()
  post(@Req() req: AppRequest, @Res() res: Response): Promise<void> {
    return this.handle(req, res);
  }

  @Get()
  get(@Req() req: AppRequest, @Res() res: Response): Promise<void> {
    return this.handle(req, res);
  }

  @Delete()
  delete(@Req() req: AppRequest, @Res() res: Response): Promise<void> {
    return this.handle(req, res);
  }

  private async handle(req: AppRequest, res: Response): Promise<void> {
    const ctx = this.factory.contextFrom(req);
    const server = this.factory.create(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
