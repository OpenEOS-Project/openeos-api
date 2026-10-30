import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { AdminAction, AdminAuditLog } from '../../database/entities';
import type { AgentToolContext } from './agent-tool.types';

/**
 * Protokoll fuer jede ausgefuehrte Mutation eines Agenten-Tools.
 *
 * Eingaben landen nicht im Protokoll (sie koennen Namen, Texte, ganze
 * Speisekarten enthalten) — nur ihr Hash, damit sich ein Aufruf spaeter
 * einem Vorgang zuordnen laesst. Best effort: ein fehlender Eintrag
 * dreht die Aktion nicht zurueck, wird aber geloggt.
 */
@Injectable()
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);

  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
  ) {}

  async record(
    ctx: AgentToolContext,
    tool: string,
    input: unknown,
    summary: string | null,
  ): Promise<void> {
    try {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          adminUserId: ctx.user.id,
          organizationId: ctx.organizationId,
          action: AdminAction.AGENT_TOOL_CALL,
          resourceType: 'agent_tool',
          resourceId: null,
          details: {
            via: 'agent',
            tool,
            tokenId: ctx.apiToken.id,
            tokenName: ctx.apiToken.name,
            inputHash: hashInput(input),
            summary,
          },
          ipAddress: (ctx.client?.ipAddress || 'unknown').slice(0, 45),
          userAgent: ctx.client?.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Protokolleintrag fuer ${tool} nicht geschrieben: ${(error as Error).message}`,
      );
    }
  }
}

/** SHA-256 ueber die Eingabe mit sortierten Schluesseln (stabil). */
export function hashInput(input: unknown): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(input))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
