import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import type { App } from 'supertest/types';

import { HttpExceptionFilter } from '../../common/filters';
import {
  AdminAuditLog,
  ApiToken,
  Event,
  User,
  UserOrganization,
} from '../../database/entities';
import { AgentAuditService } from '../agent-tools/agent-audit.service';
import { AgentToolsRegistry } from '../agent-tools/agent-tools.registry';
import { OrganizationTools } from '../agent-tools/tools/organization.tools';
import { TokenScope } from '../api-tokens/api-scopes';
import { ApiTokensService, hashToken } from '../api-tokens/api-tokens.service';
import { GatewayService } from '../gateway/gateway.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';
import { OAuthProtectedResourceController } from './oauth-protected-resource.controller';

/**
 * Der MCP-Endpunkt von aussen, mit dem offiziellen SDK-Client:
 * initialize → tools/list (nach Scopes gefiltert) → tools/call lesen →
 * Vorschau → bestaetigen (Protokoll). Dazu Anmeldung (401/403), die
 * Metadaten der geschuetzten Ressource und die Zustandslosigkeit.
 */

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const SECRET = 'oeos_mcp-secret';
const PLATFORM_SECRET = 'oeos_platform-secret';

const owner = {
  id: 'user-1',
  email: 'lena@example.org',
  isActive: true,
  isSuperAdmin: true,
} as User;

interface ErrorBody {
  error: { reason: string };
}
interface RpcBody {
  result: { serverInfo: unknown; tools: Array<{ name: string }> };
}
interface Metadata {
  authorization_servers?: unknown;
  data?: unknown;
}
interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
const parse = (result: unknown) =>
  JSON.parse((result as ToolText).content[0].text) as Record<string, unknown>;

describe('MCP over HTTP', () => {
  let app: INestApplication<App>;
  let url: URL;
  const tokens = new Map<string, Partial<ApiToken>>();
  const audits: Record<string, unknown>[] = [];
  const org = {
    id: ORG,
    name: 'TSV',
    slug: 'tsv',
    logoUrl: null,
    settings: { currency: 'EUR' },
  };
  const organizations = {
    findOne: jest.fn(() => Promise.resolve(org)),
    checkRole: jest.fn(() => Promise.resolve({ role: 'admin' })),
    update: jest.fn((_id: string, dto: { name?: string }) =>
      Promise.resolve({ ...org, name: dto.name ?? org.name }),
    ),
  };

  function issue(
    secret: string,
    scopes: TokenScope[],
    organizationId: string | null = ORG,
  ) {
    tokens.set(hashToken(secret), {
      id: `token-${secret}`,
      name: 'Agent',
      tokenHash: hashToken(secret),
      tokenPrefix: secret.slice(0, 12),
      userId: owner.id,
      user: owner,
      organizationId,
      scopes,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: new Date(),
    });
  }

  async function connect(secret: string): Promise<Client> {
    const client = new Client({ name: 'jest', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    return client;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }])],
      controllers: [McpController, OAuthProtectedResourceController],
      providers: [
        Reflector,
        ApiTokensService,
        McpAuthGuard,
        McpServerFactory,
        AgentToolsRegistry,
        AgentAuditService,
        OrganizationTools,
        { provide: OrganizationsService, useValue: organizations },
        {
          provide: GatewayService,
          useValue: { notifyOrganizationSettingsUpdated: jest.fn() },
        },
        {
          provide: getRepositoryToken(ApiToken),
          useValue: {
            findOne: ({ where }: { where: { tokenHash: string } }) =>
              Promise.resolve(tokens.get(where.tokenHash) ?? null),
            update: () => Promise.resolve(),
          },
        },
        {
          provide: getRepositoryToken(UserOrganization),
          useValue: {
            findOne: ({ where }: { where: { organizationId: string } }) =>
              Promise.resolve(
                where.organizationId === ORG
                  ? { role: 'admin', permissions: {} }
                  : null,
              ),
          },
        },
        {
          provide: getRepositoryToken(Event),
          useValue: { findOne: () => Promise.resolve(null) },
        },
        {
          provide: getRepositoryToken(AdminAuditLog),
          useValue: {
            create: (e: unknown) => e,
            save: (e: Record<string, unknown>) => (
              audits.push(e),
              Promise.resolve(e)
            ),
          },
        },
      ],
    }).compile();

    moduleRef
      .get(AgentToolsRegistry)
      .registerAll(moduleRef.get(OrganizationTools).tools());

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = (
      app.getHttpServer() as unknown as Server
    ).address() as AddressInfo;
    url = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterAll(async () => {
    /* Keep-alive-Verbindungen des SDK-Clients (undici) haengen sonst am
       Server und app.close() wartet auf sie. */
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
  }, 20000);

  beforeEach(() => {
    tokens.clear();
    audits.length = 0;
    jest.clearAllMocks();
  });

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  };
  const accept = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };

  it('answers 401 with the resource metadata challenge', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .send(initialize)
      .expect(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="http://127.0.0.1:${url.port}/.well-known/oauth-protected-resource"`,
    );
    expect((res.body as ErrorBody).error.reason).toBe('NOT_AUTHENTICATED');

    const bad = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .set('Authorization', 'Bearer oeos_wrong')
      .send(initialize)
      .expect(401);
    expect((bad.body as ErrorBody).error.reason).toBe('API_TOKEN_INVALID');
    expect(bad.headers['www-authenticate']).toContain('resource_metadata=');

    const jwt = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .set('Authorization', 'Bearer eyJhbGciOi.jwt.token')
      .send(initialize)
      .expect(401);
    expect((jwt.body as ErrorBody).error.reason).toBe('API_TOKEN_INVALID');
  });

  it('rejects platform tokens (no organization) with 403', async () => {
    issue(PLATFORM_SECRET, [TokenScope.MONITORING_READ], null);
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .set('Authorization', `Bearer ${PLATFORM_SECRET}`)
      .send(initialize)
      .expect(403);
    expect((res.body as ErrorBody).error.reason).toBe(
      'API_TOKEN_WRONG_ORGANIZATION',
    );
  });

  it('serves protected resource metadata as a bare object', async () => {
    const res = await request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource')
      .expect(200);
    const meta = res.body as Metadata;
    expect(meta).toMatchObject({
      resource: `http://127.0.0.1:${url.port}/mcp`,
      bearer_methods_supported: ['header'],
      scopes_supported: expect.arrayContaining([
        'read',
        'catalog:write',
      ]) as string[],
    });
    expect(meta.authorization_servers).toBeUndefined();
    expect(meta.data).toBeUndefined();
  });

  it('is stateless: no session id, each request on a fresh server, no initialize needed', async () => {
    issue(SECRET, [TokenScope.READ]);
    const init = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .set('Authorization', `Bearer ${SECRET}`)
      .send(initialize)
      .expect(200);
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect((init.body as RpcBody).result.serverInfo).toEqual({
      name: 'openeos',
      version: expect.any(String) as string,
    });
    expect(init.headers['x-ratelimit-limit-api-token-minute']).toBe('120');

    const bare = await request(app.getHttpServer())
      .post('/mcp')
      .set(accept)
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);
    expect((bare.body as RpcBody).result.tools.map((t) => t.name)).toEqual([
      'get_organization',
    ]);

    const first = await connect(SECRET);
    const second = await connect(SECRET);
    expect((await second.listTools()).tools).toHaveLength(1);
    expect((await first.listTools()).tools).toHaveLength(1);
    await first.close();
    await second.close();
  });

  it('lists only tools the scopes allow and runs read tools', async () => {
    issue(SECRET, [TokenScope.READ]);
    const client = await connect(SECRET);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_organization']);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' });
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true });

    const result = await client.callTool({
      name: 'get_organization',
      arguments: {},
    });
    expect(parse(result)).toMatchObject({
      id: ORG,
      name: 'TSV',
      currency: 'EUR',
    });

    const hidden = (await client.callTool({
      name: 'update_organization',
      arguments: { name: 'X', confirm: true },
    })) as ToolText;
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toMatch(/not found/);
    expect(organizations.update).not.toHaveBeenCalled();

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(
      'openeos://docs/produkte',
    );
    const doc = await client.readResource({ uri: 'openeos://docs/tische' });
    expect((doc.contents[0] as { text?: string }).text).toContain('# Tische');
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      'daily_summary',
      'setup_event',
    ]);
    const prompt = await client.getPrompt({
      name: 'setup_event',
      arguments: { eventName: 'Sommerfest' },
    });
    expect(prompt.messages[0].content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Sommerfest') as string,
    });
    await client.close();
  });

  it('previews, then applies with confirm and writes an audit entry', async () => {
    issue(SECRET, [TokenScope.READ, TokenScope.SETTINGS_WRITE]);
    const client = await connect(SECRET);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'get_organization',
      'update_organization',
    ]);

    const previewResult = parse(
      await client.callTool({
        name: 'update_organization',
        arguments: { name: 'TSV 1900' },
      }),
    );
    expect(previewResult).toMatchObject({
      preview: true,
      changes: { name: { from: 'TSV', to: 'TSV 1900' } },
    });
    expect(organizations.update).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);

    const applied = parse(
      await client.callTool({
        name: 'update_organization',
        arguments: { name: 'TSV 1900', confirm: true },
      }),
    );
    expect(applied).toMatchObject({
      ok: true,
      organization: { name: 'TSV 1900' },
    });
    expect(organizations.update).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'agent_tool_call',
      organizationId: ORG,
      adminUserId: owner.id,
      details: {
        via: 'agent',
        tool: 'update_organization',
        tokenName: 'Agent',
        inputHash: expect.any(String) as string,
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain('TSV 1900');

    const invalid = (await client.callTool({
      name: 'update_organization',
      arguments: { name: 'X', confirm: true },
    })) as ToolText;
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/name/);
    expect(organizations.update).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('turns service errors into tool errors, not transport errors', async () => {
    issue(SECRET, [TokenScope.READ]);
    organizations.findOne.mockRejectedValueOnce(
      new ForbiddenException({
        code: 'FORBIDDEN',
        reason: 'ORGANIZATION_ACCESS_DENIED',
        message: 'Kein Zugriff',
      }),
    );
    const client = await connect(SECRET);
    const result = (await client.callTool({
      name: 'get_organization',
      arguments: {},
    })) as ToolText;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text) as unknown).toMatchObject({
      error: 'ORGANIZATION_ACCESS_DENIED',
      status: 403,
    });
    await client.close();
  });
});
