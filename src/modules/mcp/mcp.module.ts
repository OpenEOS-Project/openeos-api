import { Module } from '@nestjs/common';

import { AgentToolsModule } from '../agent-tools';
import { ApiTokensModule } from '../api-tokens/api-tokens.module';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';
import { OAuthProtectedResourceController } from './oauth-protected-resource.controller';

/** MCP-Server fuer KI-Agenten (ki-plan.md Abschnitt 2.5 und 9). */
@Module({
  imports: [AgentToolsModule, ApiTokensModule],
  controllers: [McpController, OAuthProtectedResourceController],
  providers: [McpServerFactory, McpAuthGuard],
})
export class McpModule {}
