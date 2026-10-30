import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  PrintTemplateType,
  type Device,
  type Printer,
  type PrintTemplate,
} from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { DevicesService } from '../../devices/devices.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { PrintersService } from '../../printers/printers.service';
import type { CreatePrintTemplateDto, UpdatePrintTemplateDto } from '../../print-templates/dto';
import { PrintTemplatesService } from '../../print-templates/print-templates.service';
import { OrganizationRole } from '../../../database/entities';
import { defineTool, type AgentTool } from '../agent-tool.types';
import { confirmInput, defined, diff, done, fetchAll, iso, listInput, preview, slice, uuid, windowed } from '../tool-helpers';

/* Geraete tragen ihr Zugangstoken und den Kopplungscode in der Entitaet
   — beides bleibt hier draussen, es wird nur eine Auswahl abgebildet. */
function compactDevice(device: Device) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    status: device.status,
    isActive: device.isActive,
    lastSeenAt: iso(device.lastSeenAt),
    online: typeof device.isOnline === 'function' ? device.isOnline() : null,
  };
}

function compactPrinter(printer: Printer) {
  return {
    id: printer.id,
    name: printer.name,
    type: printer.type,
    connectionType: printer.connectionType,
    paperWidth: printer.paperWidth,
    hasCashDrawer: printer.hasCashDrawer,
    isActive: printer.isActive,
    isOnline: printer.isOnline,
    lastSeenAt: iso(printer.lastSeenAt),
    agentDeviceId: printer.deviceId ?? null,
  };
}

function compactTemplate(template: PrintTemplate, includeDefinition = false) {
  return {
    id: template.id,
    name: template.name,
    type: template.type,
    isDefault: template.isDefault,
    ...(includeDefinition ? { template: template.template } : {}),
  };
}

const templateDefinition = z
  .object({})
  .passthrough()
  .describe('Template definition as used by the web app (sections, width, fontSize …)');

@Injectable()
export class DeviceTools {
  constructor(
    private readonly devices: DevicesService,
    private readonly printers: PrintersService,
    private readonly templates: PrintTemplatesService,
    private readonly organizations: OrganizationsService,
  ) {}

  tools(): AgentTool[] {
    return [
      this.listDevices(),
      this.listPrinters(),
      this.listTemplates(),
      this.createTemplate(),
      this.updateTemplate(),
    ];
  }

  private listDevices() {
    return defineTool({
      name: 'list_devices',
      description: 'POS devices, displays and printer agents of the organization with status and last contact. No credentials.',
      inputSchema: z.object({ type: z.enum(['pos', 'display', 'admin', 'printer_agent']).optional(), ...listInput }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        if (input.type) {
          const all = await fetchAll((p) => this.devices.findAll(ctx.organizationId, ctx.user, p));
          const page = slice(all.filter((d) => d.type === input.type), input.offset, input.limit);
          return { ...page, items: page.items.map(compactDevice) };
        }
        const page = await windowed(
          (p) => this.devices.findAll(ctx.organizationId, ctx.user, p),
          input.offset,
          input.limit,
        );
        return { ...page, items: page.items.map(compactDevice) };
      },
    });
  }

  private listPrinters() {
    return defineTool({
      name: 'list_printers',
      description: 'Printers of the organization (receipt/kitchen/label) with online state. Read-only; printers are set up in the web app.',
      inputSchema: z.object({ ...listInput }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        const page = await windowed(
          (p) => this.printers.findAll(ctx.organizationId, ctx.user, p),
          input.offset,
          input.limit,
        );
        return { ...page, items: page.items.map(compactPrinter) };
      },
    });
  }

  private listTemplates() {
    return defineTool({
      name: 'list_print_templates',
      description: 'Receipt/ticket templates. includeDefinition returns the full template JSON (large).',
      inputSchema: z
        .object({
          type: z.nativeEnum(PrintTemplateType).optional(),
          includeDefinition: z.boolean().default(false),
          ...listInput,
        })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        let all = await fetchAll((p) => this.templates.findAll(ctx.organizationId, ctx.user, p));
        if (input.type) all = all.filter((t) => t.type === input.type);
        const page = slice(all, input.offset, input.limit);
        return { ...page, items: page.items.map((t) => compactTemplate(t, input.includeDefinition)) };
      },
    });
  }

  private createTemplate() {
    return defineTool({
      name: 'create_print_template',
      description: 'Create a print template (receipt, kitchen_ticket, order_ticket). Admin only. isDefault makes it the default of its type.',
      inputSchema: z
        .object({
          name: z.string().min(1).max(255),
          type: z.nativeEnum(PrintTemplateType),
          template: templateDefinition.optional(),
          isDefault: z.boolean().optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.DEVICES_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...rest } = input;
        const dto = defined(rest) as CreatePrintTemplateDto;
        if (!confirm) {
          await this.organizations.checkRole(ctx.organizationId, ctx.user, OrganizationRole.ADMIN);
          return preview(`Würde Vorlage „${dto.name}“ (${dto.type}) anlegen`, {
            wouldCreate: { name: dto.name, type: dto.type, isDefault: dto.isDefault ?? false, hasDefinition: !!dto.template },
          });
        }
        const template = await this.templates.create(ctx.organizationId, dto, ctx.user);
        return done(`Vorlage „${template.name}“ angelegt`, { template: compactTemplate(template) });
      },
    });
  }

  private updateTemplate() {
    return defineTool({
      name: 'update_print_template',
      description: 'Rename a print template, replace its definition (whole object) or make it the default. Admin only.',
      inputSchema: z
        .object({
          templateId: uuid,
          name: z.string().min(1).max(255).optional(),
          template: templateDefinition.optional(),
          isDefault: z.boolean().optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.DEVICES_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { templateId, confirm, ...rest } = input;
        const template = await this.templates.findOne(ctx.organizationId, templateId, ctx.user);
        const dto = defined(rest) as UpdatePrintTemplateDto;
        const changes = diff(
          { name: template.name, isDefault: template.isDefault, template: template.template },
          dto as Record<string, unknown>,
        );
        const keys = Object.keys(changes);
        if (!confirm) {
          await this.organizations.checkRole(ctx.organizationId, ctx.user, OrganizationRole.ADMIN);
          return preview(
            keys.length ? `Würde Vorlage „${template.name}“ ändern: ${keys.join(', ')}` : `Keine Änderung an Vorlage „${template.name}“`,
            { changes: keys.includes('template') ? { ...changes, template: { from: '(definition)', to: '(new definition)' } } : changes },
          );
        }
        if (keys.length === 0) return done(`Keine Änderung an Vorlage „${template.name}“`, { template: compactTemplate(template) });
        const updated = await this.templates.update(ctx.organizationId, templateId, dto, ctx.user);
        return done(`Vorlage „${updated.name}“ geändert: ${keys.join(', ')}`, { template: compactTemplate(updated) });
      },
    });
  }
}
