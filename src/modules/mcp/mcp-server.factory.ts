import { HttpException, Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { AppRequest } from '../../common/types/request.types';
import type { User } from '../../database/entities';
import {
  AgentToolError,
  AgentToolsRegistry,
  type AgentTool,
  type AgentToolContext,
} from '../agent-tools';
import { MCP_DOCS } from './mcp-docs';
import { registerPrompts } from './mcp-prompts';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './mcp.constants';

const INSTRUCTIONS = [
  'OpenEOS is a point-of-sale system for clubs, festivals and events in Germany.',
  'All tools act for exactly one organization — the one the API token belongs to; ids in inputs must belong to it.',
  'Tools you cannot see are not allowed for this token. Writing tools take `confirm`: call them with confirm=false first to get a preview, show it to the user, then call again with confirm=true.',
  'Agents only administer: no cashier functions, no refunds, no members, no deletion, no event activation or billing — those stay in the web app.',
  'Money is EUR as decimal numbers, dates ISO-8601. Keep answers short; talk to users in German (du-form).',
  'Resources openeos://docs/<slug> hold documentation excerpts (produkte, veranstaltungen, tische, drucker, schichten).',
].join(' ');

/**
 * Baut je Anfrage einen frischen `McpServer` — zustandslos, damit zwei
 * Instanzen hinter einem Load-Balancer dieselbe Antwort geben und keine
 * Sitzung an einer Instanz klebt.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger('Mcp');

  constructor(private readonly registry: AgentToolsRegistry) {}

  /** Wer ruft — aus den Feldern, die der McpAuthGuard gesetzt hat. */
  contextFrom(request: AppRequest): AgentToolContext {
    if (!request.user || !request.apiToken?.organizationId) {
      throw new Error('MCP request without authenticated API token');
    }
    return {
      user: request.user as unknown as User,
      organizationId: request.apiToken.organizationId,
      apiToken: request.apiToken,
      client: {
        ipAddress: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    };
  }

  create(ctx: AgentToolContext): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { instructions: INSTRUCTIONS },
    );

    for (const tool of this.registry.list(ctx.apiToken.scopes)) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: !tool.mutating,
            destructiveHint: false,
            idempotentHint: !tool.mutating,
            openWorldHint: false,
          },
        },
        (args: unknown) => this.run(tool, ctx, args),
      );
    }

    for (const doc of MCP_DOCS) {
      server.registerResource(
        `docs-${doc.slug}`,
        `openeos://docs/${doc.slug}`,
        {
          title: doc.title,
          description: doc.description,
          mimeType: 'text/markdown',
        },
        (uri) => ({
          contents: [
            { uri: uri.href, mimeType: 'text/markdown', text: doc.text },
          ],
        }),
      );
    }

    registerPrompts(server);
    return server;
  }

  private async run(
    tool: AgentTool,
    ctx: AgentToolContext,
    args: unknown,
  ): Promise<CallToolResult> {
    try {
      const result = await this.registry.call(tool.name, ctx, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(this.describe(error)) }],
      };
    }
  }

  /* Fehler so, dass ein Modell sie dem Menschen erklaeren kann — Code
     und Text, keine Stacktraces. Unerwartetes landet im Log. */
  private describe(error: unknown): Record<string, unknown> {
    if (error instanceof AgentToolError) {
      return {
        error: error.code,
        message: error.message,
        details: error.details ?? undefined,
      };
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const info =
        typeof body === 'object' && body
          ? (body as Record<string, unknown>)
          : {};
      return {
        error: (info.reason as string) || (info.code as string) || 'HTTP_ERROR',
        message: (info.message as string) || error.message,
        status: error.getStatus(),
        params: info.params,
        details: info.details,
      };
    }
    this.logger.error(
      `Tool failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    return { error: 'INTERNAL_ERROR', message: 'Unerwarteter Fehler' };
  }
}
