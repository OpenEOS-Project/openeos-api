import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TokenScope } from '../../api-tokens/api-scopes';
import { AssistantService } from '../../assistant/assistant.service';
import { IconSuggestionService } from '../../assistant/icon-suggestion.service';
import { defineTool, type AgentTool } from '../agent-tool.types';

@Injectable()
export class IconTools {
  constructor(
    private readonly assistant: AssistantService,
    private readonly icons: IconSuggestionService,
  ) {}

  tools(): AgentTool[] {
    return [
      defineTool({
        name: 'suggest_icons',
        description:
          'Suggest POS icons (pos-icon:<id>) for product names, up to 3 per name with a score. Use the icon value in upsert_products. Requires the assistant to be enabled for the organization.',
        inputSchema: z
          .object({
            names: z.array(z.string().min(1).max(255)).min(1).max(100),
          })
          .strict(),
        scope: TokenScope.READ,
        mutating: false,
        handler: async (ctx, input) => {
          await this.assistant.getStatus(ctx.organizationId, ctx.user);
          await this.assistant.assertUsable(ctx.organizationId);
          const results = await this.icons.suggest(
            ctx.organizationId,
            ctx.user.id,
            input.names,
          );
          return {
            items: results.map((r) => ({
              name: r.name,
              suggestions: r.suggestions.map((s) => ({
                icon: s.icon,
                score: Math.round(s.score * 100) / 100,
              })),
            })),
          };
        },
      }),
    ];
  }
}
