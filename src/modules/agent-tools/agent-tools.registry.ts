import { HttpException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AgentAuditService } from './agent-audit.service';
import {
  AgentTool,
  AgentToolContext,
  AgentToolError,
  isPreview,
} from './agent-tool.types';

/**
 * Alle Werkzeuge an einer Stelle: wer sie sieht (Scope), was sie
 * brauchen (Schema) und was danach passiert (Protokoll).
 *
 * Der Aufruf prueft Scope und Eingabe selbst — auch wenn der MCP-Server
 * die Liste schon gefiltert und das SDK die Eingabe validiert hat. Zwei
 * Pruefungen sind billig; eine vergessene waere teuer.
 */
@Injectable()
export class AgentToolsRegistry {
  private readonly logger = new Logger('AgentTools');
  private readonly tools = new Map<string, AgentTool>();

  constructor(private readonly audit: AgentAuditService) {}

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Agent tool already registered: ${tool.name}`);
    }
    if (tool.mutating && !hasConfirm(tool.inputSchema)) {
      throw new Error(`Mutating tool ${tool.name} needs a 'confirm' input`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  all(): AgentTool[] {
    return [...this.tools.values()];
  }

  /** Nur, was der Token darf — alles andere bleibt unsichtbar. */
  list(scopes: readonly string[]): AgentTool[] {
    return this.all().filter((tool) => scopes.includes(tool.scope));
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async call(
    name: string,
    ctx: AgentToolContext,
    rawInput: unknown,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AgentToolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
    }
    if (!ctx.apiToken.scopes.includes(tool.scope)) {
      throw new AgentToolError(
        'SCOPE_MISSING',
        `API-Token fehlt die Berechtigung „${tool.scope}“`,
        { scope: tool.scope },
      );
    }

    const parsed = tool.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new AgentToolError(
        'INVALID_INPUT',
        parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
          .join('; '),
        parsed.error.issues,
      );
    }

    const started = Date.now();
    try {
      const result = await tool.handler(ctx, parsed.data);
      const confirmed =
        tool.mutating &&
        (parsed.data as { confirm?: boolean }).confirm === true &&
        !isPreview(result);
      if (confirmed) {
        const summary = (result as { summary?: unknown })?.summary;
        await this.audit.record(
          ctx,
          tool.name,
          parsed.data,
          typeof summary === 'string' ? summary : null,
        );
      }
      this.log(tool, ctx, started, confirmed ? 'ok (applied)' : 'ok');
      return result;
    } catch (error) {
      this.log(tool, ctx, started, `error ${describe(error)}`);
      throw error;
    }
  }

  /* Eine Zeile je Aufruf: Werkzeug, Token, Dauer, Ergebnis — nie die Eingabe. */
  private log(
    tool: AgentTool,
    ctx: AgentToolContext,
    started: number,
    outcome: string,
  ): void {
    this.logger.log(
      `tool=${tool.name} token=${ctx.apiToken.id} org=${ctx.organizationId} ms=${Date.now() - started} ${outcome}`,
    );
  }
}

function hasConfirm(schema: z.ZodTypeAny): boolean {
  const shape = (schema as z.AnyZodObject).shape as
    | Record<string, unknown>
    | undefined;
  return !!shape && 'confirm' in shape;
}

function describe(error: unknown): string {
  if (error instanceof AgentToolError) return error.code;
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body) {
      const { reason, code } = body as { reason?: string; code?: string };
      return reason || code || String(error.getStatus());
    }
    return String(error.getStatus());
  }
  return error instanceof Error ? error.name : 'unknown';
}
