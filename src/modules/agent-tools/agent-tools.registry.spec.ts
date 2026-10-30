import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';

import type { User } from '../../database/entities';
import { TokenScope } from '../api-tokens/api-scopes';
import { AgentAuditService, hashInput } from './agent-audit.service';
import { AgentToolsRegistry } from './agent-tools.registry';
import {
  AgentToolError,
  defineTool,
  type AgentToolContext,
} from './agent-tool.types';
import { confirmInput, preview } from './tool-helpers';

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

function context(scopes: string[]): AgentToolContext {
  return {
    user: { id: 'user-1' } as User,
    organizationId: ORG,
    apiToken: { id: 'token-1', name: 'Agent', scopes, organizationId: ORG },
    client: { ipAddress: '10.0.0.1', userAgent: 'jest' },
  };
}

describe('AgentToolsRegistry', () => {
  const audit = { record: jest.fn(() => Promise.resolve()) };
  let registry: AgentToolsRegistry;
  const create = jest.fn(() => Promise.resolve({ id: 'c-1' }));

  const readTool = defineTool({
    name: 'list_things',
    description: 'read',
    inputSchema: z
      .object({ limit: z.number().int().max(100).default(50) })
      .strict(),
    scope: TokenScope.READ,
    mutating: false,
    handler: (_ctx, input) =>
      Promise.resolve({ items: [], limit: input.limit }),
  });
  const writeTool = defineTool({
    name: 'create_thing',
    description: 'write',
    inputSchema: z
      .object({ name: z.string().min(2), ...confirmInput })
      .strict(),
    scope: TokenScope.CATALOG_WRITE,
    mutating: true,
    handler: async (_ctx, input) => {
      if (!input.confirm) return preview(`Würde „${input.name}“ anlegen`);
      await create();
      return { ok: true, summary: `„${input.name}“ angelegt` };
    },
  });
  const failingTool = defineTool({
    name: 'fail_thing',
    description: 'throws like a service',
    inputSchema: z.object({}).strict(),
    scope: TokenScope.READ,
    mutating: false,
    handler: () =>
      Promise.reject(
        new ForbiddenException({
          code: 'FORBIDDEN',
          reason: 'INSUFFICIENT_PERMISSIONS',
        }),
      ),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new AgentToolsRegistry(audit as unknown as AgentAuditService);
    registry.registerAll([readTool, writeTool, failingTool]);
  });

  it('refuses a mutating tool without confirm and duplicate names', () => {
    expect(() =>
      registry.register(
        defineTool({
          name: 'bad',
          description: '',
          inputSchema: z.object({}),
          scope: TokenScope.READ,
          mutating: true,
          handler: () => Promise.resolve({}),
        }),
      ),
    ).toThrow(/confirm/);
    expect(() => registry.register(readTool)).toThrow(/already registered/);
  });

  it('lists only tools the scopes allow', () => {
    expect(registry.list(['read']).map((t) => t.name)).toEqual([
      'list_things',
      'fail_thing',
    ]);
    expect(registry.list(['catalog:write']).map((t) => t.name)).toEqual([
      'create_thing',
    ]);
    expect(registry.list([])).toEqual([]);
  });

  it('rejects unknown tools, missing scopes and invalid input', async () => {
    await expect(
      registry.call('nope', context(['read']), {}),
    ).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
    await expect(
      registry.call('create_thing', context(['read']), {
        name: 'Bier',
        confirm: true,
      }),
    ).rejects.toMatchObject({
      code: 'SCOPE_MISSING',
      details: { scope: 'catalog:write' },
    });
    expect(create).not.toHaveBeenCalled();

    const error = await registry
      .call('list_things', context(['read']), { limit: 1000 })
      .catch((e: AgentToolError) => e);
    expect(error).toBeInstanceOf(AgentToolError);
    expect((error as AgentToolError).code).toBe('INVALID_INPUT');
    expect((error as AgentToolError).message).toMatch(/limit/);

    await expect(
      registry.call('list_things', context(['read']), { extra: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('applies defaults and never audits reads', async () => {
    await expect(
      registry.call('list_things', context(['read']), undefined),
    ).resolves.toEqual({
      items: [],
      limit: 50,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('previews without confirm and writes nothing', async () => {
    const result = await registry.call(
      'create_thing',
      context(['catalog:write']),
      {
        name: 'Bier',
      },
    );
    expect(result).toMatchObject({
      preview: true,
      summary: 'Würde „Bier“ anlegen',
    });
    expect(create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('applies with confirm and writes one audit entry with the input hash', async () => {
    const ctx = context(['catalog:write']);
    const result = await registry.call('create_thing', ctx, {
      name: 'Bier',
      confirm: true,
    });
    expect(result).toEqual({ ok: true, summary: '„Bier“ angelegt' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      ctx,
      'create_thing',
      { name: 'Bier', confirm: true },
      '„Bier“ angelegt',
    );
  });

  it('lets service exceptions through unchanged', async () => {
    await expect(
      registry.call('fail_thing', context(['read']), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('hashInput', () => {
  it('is stable across key order and undefined fields', () => {
    expect(hashInput({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(
      hashInput({ b: [1, { c: 2 }], a: 1 }),
    );
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });
});

describe('AgentAuditService', () => {
  it('stores via=agent, tool, token and hash — not the input', async () => {
    const saved: Record<string, unknown>[] = [];
    const repo = {
      create: (e: unknown) => e,
      save: (e: Record<string, unknown>) => (saved.push(e), Promise.resolve(e)),
    };
    const service = new AgentAuditService(repo as never);
    const ctx = context(['catalog:write']);
    await service.record(ctx, 'create_thing', { name: 'Geheim' }, 'angelegt');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      adminUserId: 'user-1',
      organizationId: ORG,
      action: 'agent_tool_call',
      resourceType: 'agent_tool',
      ipAddress: '10.0.0.1',
      userAgent: 'jest',
      details: {
        via: 'agent',
        tool: 'create_thing',
        tokenId: 'token-1',
        tokenName: 'Agent',
        summary: 'angelegt',
      },
    });
    expect(JSON.stringify(saved[0])).not.toContain('Geheim');
    expect((saved[0].details as { inputHash: string }).inputHash).toHaveLength(
      64,
    );
  });
});
