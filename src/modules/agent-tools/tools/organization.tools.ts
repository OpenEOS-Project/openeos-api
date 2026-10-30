import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  OrganizationRole,
  type Organization,
} from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { GatewayService } from '../../gateway/gateway.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import type { UpdateOrganizationDto } from '../../organizations/dto';
import { defineTool, type AgentTool } from '../agent-tool.types';
import { confirmInput, defined, diff, done, preview } from '../tool-helpers';

const addressInput = z
  .object({
    street: z.string().max(200),
    city: z.string().max(100),
    zip: z.string().max(20),
    country: z.string().length(2).describe('ISO 3166-1 alpha-2, e.g. DE'),
  })
  .partial()
  .strict();

/**
 * Nur, was PATCH /organizations/:id heute auch zulaesst — und davon nur
 * die Betriebs-Einstellungen. Zahlungsanbieter, Rechtstexte, Steuerstatus,
 * Abrechnung und der Assistent-Schalter bleiben der Web-App vorbehalten.
 */
const settingsInput = z
  .object({
    currency: z.string().length(3).optional(),
    timezone: z.string().max(64).optional(),
    locale: z.string().max(10).optional(),
    address: addressInput.optional(),
    contact: z
      .object({ email: z.string().email().max(255), phone: z.string().max(50) })
      .partial()
      .strict()
      .optional(),
    receipt: z
      .object({
        headerText: z.string().max(500),
        footerText: z.string().max(500),
        showTaxDetails: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    pos: z
      .object({ orderingMode: z.enum(['immediate', 'tab']) })
      .partial()
      .strict()
      .optional(),
    pfand: z
      .object({ tableService: z.boolean(), counterPickup: z.boolean() })
      .partial()
      .strict()
      .optional(),
    onlineOrdering: z
      .object({
        enabled: z.boolean(),
        requirePayment: z.boolean(),
        maxItemsPerOrder: z.number().int().min(1).max(500),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

type SettingsKey = keyof z.infer<typeof settingsInput>;
const SETTINGS_KEYS: SettingsKey[] = [
  'currency',
  'timezone',
  'locale',
  'address',
  'contact',
  'receipt',
  'pos',
  'pfand',
  'onlineOrdering',
];

export function compactOrganization(org: Organization) {
  const s = org.settings ?? ({} as Organization['settings']);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoUrl ?? null,
    currency: s.currency ?? null,
    timezone: s.timezone ?? null,
    locale: s.locale ?? null,
    vatExempt: s.vatExempt === true,
    address: s.address ?? null,
    contact: s.contact ?? null,
    receipt: s.receipt ?? null,
    pos: s.pos ?? null,
    pfand: s.pfand ?? null,
    onlineOrdering: s.onlineOrdering ?? null,
    assistantEnabled: s.assistant?.enabled === true,
  };
}

@Injectable()
export class OrganizationTools {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly gateway: GatewayService,
  ) {}

  tools(): AgentTool[] {
    return [this.getOrganization(), this.updateOrganization()];
  }

  private getOrganization() {
    return defineTool({
      name: 'get_organization',
      description:
        'The organization this token belongs to: name, currency, timezone, address, contact, receipt texts, POS defaults. No billing or payment credentials.',
      inputSchema: z.object({}).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx) =>
        compactOrganization(
          await this.organizations.findOne(ctx.organizationId, ctx.user),
        ),
    });
  }

  private updateOrganization() {
    return defineTool({
      name: 'update_organization',
      description:
        'Update organization name, logo URL or operational settings (currency, timezone, locale, address, contact, receipt texts, POS ordering mode, Pfand options, online ordering). Sub-objects are merged with the current values. Admin only. Cannot touch billing, payment providers, legal texts or tax status.',
      inputSchema: z
        .object({
          name: z.string().min(2).max(200).optional(),
          logoUrl: z.string().url().max(500).nullable().optional(),
          settings: settingsInput.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.SETTINGS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const org = await this.organizations.findOne(
          ctx.organizationId,
          ctx.user,
        );
        await this.organizations.checkRole(
          ctx.organizationId,
          ctx.user,
          OrganizationRole.ADMIN,
        );

        const current = (org.settings ?? {}) as unknown as Record<string, unknown>;
        const settingsPatch: Record<string, unknown> = {};
        for (const key of SETTINGS_KEYS) {
          const value = input.settings?.[key];
          if (value === undefined) continue;
          const existing = current[key];
          settingsPatch[key] =
            typeof value === 'object' &&
            value !== null &&
            typeof existing === 'object' &&
            existing !== null
              ? { ...existing, ...value }
              : value;
        }

        const before: Record<string, unknown> = {
          name: org.name,
          logoUrl: org.logoUrl ?? null,
        };
        for (const key of Object.keys(settingsPatch)) {
          before[key] = current[key] ?? null;
        }
        const after = {
          ...defined({ name: input.name, logoUrl: input.logoUrl }),
          ...settingsPatch,
        };
        const changes = diff(before, after);
        const count = Object.keys(changes).length;
        const summary =
          count === 0
            ? 'Nichts zu ändern'
            : `${count} Einstellung${count === 1 ? '' : 'en'} ändern: ${Object.keys(changes).join(', ')}`;

        if (!input.confirm) {
          return preview(`Würde ${summary}`, { changes });
        }
        if (count === 0) {
          return done(summary, { organization: compactOrganization(org) });
        }

        const dto: UpdateOrganizationDto = {
          ...defined({ name: input.name, logoUrl: input.logoUrl ?? undefined }),
        };
        if (Object.keys(settingsPatch).length > 0) dto.settings = settingsPatch;
        const updated = await this.organizations.update(
          ctx.organizationId,
          dto,
          ctx.user,
        );
        if (dto.settings) {
          this.gateway.notifyOrganizationSettingsUpdated(updated.id);
        }
        return done(`Organisation aktualisiert: ${Object.keys(changes).join(', ')}`, {
          changes,
          organization: compactOrganization(updated),
        });
      },
    });
  }
}
