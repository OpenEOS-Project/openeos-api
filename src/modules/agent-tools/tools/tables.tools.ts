import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { DiningTable, TableArea } from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { OrganizationsService } from '../../organizations/organizations.service';
import type {
  BulkCreateDiningTablesDto,
  CreateTableAreaDto,
  UpdateDiningTableDto,
} from '../../tables/dto';
import { bulkLabels, TablesService } from '../../tables/tables.service';
import {
  AgentToolError,
  defineTool,
  type AgentTool,
} from '../agent-tool.types';
import {
  confirmInput,
  defined,
  diff,
  done,
  notFound,
  preview,
  sameName,
  uuid,
} from '../tool-helpers';

function compactTable(table: DiningTable) {
  return {
    id: table.id,
    label: table.label,
    areaId: table.areaId,
    seats: table.seats ?? null,
    shape: table.shape,
    isActive: table.isActive,
  };
}

function compactArea(
  area: TableArea & { tables?: DiningTable[] },
  includeInactive: boolean,
) {
  const tables = (area.tables ?? []).filter(
    (t) => includeInactive || t.isActive,
  );
  return {
    id: area.id,
    name: area.name,
    sortOrder: area.sortOrder,
    width: area.width,
    height: area.height,
    tableCount: tables.length,
    tables: tables.map(compactTable),
  };
}

@Injectable()
export class TableTools {
  constructor(
    private readonly tables: TablesService,
    private readonly organizations: OrganizationsService,
  ) {}

  tools(): AgentTool[] {
    return [
      this.listAreas(),
      this.createArea(),
      this.createTables(),
      this.updateTable(),
    ];
  }

  private listAreas() {
    return defineTool({
      name: 'list_table_areas',
      description:
        'Table areas (tent, hall, beer garden …) of the organization with their tables. Areas belong to the organization, not to an event.',
      inputSchema: z
        .object({ includeInactive: z.boolean().default(false) })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        const areas = await this.tables.listAreas(ctx.organizationId, ctx.user);
        return {
          items: areas.map((a) => compactArea(a, input.includeInactive)),
          total: areas.length,
        };
      },
    });
  }

  private createArea() {
    return defineTool({
      name: 'create_table_area',
      description:
        'Create a table area. Name must be unique in the organization.',
      inputSchema: z
        .object({
          name: z.string().min(1).max(60),
          width: z
            .number()
            .int()
            .min(400)
            .max(5000)
            .optional()
            .describe('Map width in units (default 1200; a table is 80)'),
          height: z.number().int().min(400).max(5000).optional(),
          gridSize: z.number().int().min(5).max(100).optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.TABLES_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...rest } = input;
        const dto = defined(rest) as CreateTableAreaDto;
        const areas = await this.tables.listAreas(ctx.organizationId, ctx.user);
        const duplicate = areas.find((a) => sameName(a.name, dto.name));
        if (duplicate) {
          throw new AgentToolError(
            'CONFLICT',
            `Bereich „${duplicate.name}“ gibt es schon (${duplicate.id})`,
          );
        }
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(`Würde Bereich „${dto.name}“ anlegen`, {
            wouldCreate: dto,
          });
        }
        const area = await this.tables.createArea(
          ctx.organizationId,
          dto,
          ctx.user,
        );
        return done(`Bereich „${area.name}“ angelegt`, {
          area: compactArea(area, true),
        });
      },
    });
  }

  private createTables() {
    return defineTool({
      name: 'create_tables',
      description:
        'Create a series of tables in an area: prefix + numbers, e.g. prefix "A", start 1, count 12, padding 2 → A01…A12. Labels are unique across the organization; the preview lists collisions.',
      inputSchema: z
        .object({
          areaId: uuid,
          prefix: z.string().max(19).default(''),
          start: z.number().int().min(0).max(99999).default(1),
          count: z.number().int().min(1).max(100),
          padding: z
            .number()
            .int()
            .min(0)
            .max(3)
            .default(0)
            .describe('Digits, 2 → A01'),
          seats: z.number().int().min(1).max(99).optional(),
          shape: z.enum(['rect', 'round']).optional(),
          layout: z
            .object({
              cols: z.number().int().min(1).max(50),
              gap: z.number().int().min(0).max(500),
            })
            .strict()
            .optional()
            .describe(
              'Grid placement on the map; without it tables stack at 0,0',
            ),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.TABLES_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...rest } = input;
        const areas = await this.tables.listAreas(ctx.organizationId, ctx.user);
        const area = areas.find((a) => a.id === rest.areaId);
        if (!area) throw notFound('Bereich', rest.areaId);
        const labels = bulkLabels(
          rest.prefix,
          rest.start,
          rest.count,
          rest.padding,
        );
        const tooLong = labels.filter((l) => l.length > 20);
        if (tooLong.length) {
          throw new AgentToolError(
            'INVALID_INPUT',
            `Bezeichnung länger als 20 Zeichen: ${tooLong[0]}`,
          );
        }
        const existing = new Set(
          areas
            .flatMap((a) => a.tables ?? [])
            .map((t) => t.label.toLocaleLowerCase('de')),
        );
        const collisions = labels.filter((l) =>
          existing.has(l.toLocaleLowerCase('de')),
        );
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(
            collisions.length
              ? `${collisions.length} von ${labels.length} Bezeichnungen sind schon belegt — Präfix oder Start ändern`
              : `Würde ${labels.length} Tische ${labels[0]}…${labels[labels.length - 1]} in „${area.name}“ anlegen`,
            { area: area.name, labels, collisions },
          );
        }
        if (collisions.length) {
          throw new AgentToolError(
            'CONFLICT',
            `Bezeichnungen schon belegt: ${collisions.join(', ')}`,
            collisions,
          );
        }
        const dto = defined(rest) as BulkCreateDiningTablesDto;
        const tables = await this.tables.bulkCreate(
          ctx.organizationId,
          dto,
          ctx.user,
        );
        return done(`${tables.length} Tische in „${area.name}“ angelegt`, {
          tables: tables.map(compactTable),
        });
      },
    });
  }

  private updateTable() {
    return defineTool({
      name: 'update_table',
      description:
        'Rename a table, change seats/shape, move it to another area or set it inactive.',
      inputSchema: z
        .object({
          tableId: uuid,
          label: z.string().min(1).max(20).optional(),
          seats: z.number().int().min(1).max(99).nullable().optional(),
          shape: z.enum(['rect', 'round']).optional(),
          areaId: uuid.optional(),
          isActive: z.boolean().optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.TABLES_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { tableId, confirm, ...rest } = input;
        const areas = await this.tables.listAreas(ctx.organizationId, ctx.user);
        const table = areas
          .flatMap((a) => a.tables ?? [])
          .find((t) => t.id === tableId);
        if (!table) throw notFound('Tisch', tableId);
        if (rest.areaId && !areas.some((a) => a.id === rest.areaId))
          throw notFound('Bereich', rest.areaId);
        const dto = defined(rest) as UpdateDiningTableDto;
        const changes = diff(
          compactTable(table) as unknown as Record<string, unknown>,
          dto as Record<string, unknown>,
        );
        const keys = Object.keys(changes);
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(
            keys.length
              ? `Würde Tisch „${table.label}“ ändern: ${keys.join(', ')}`
              : `Keine Änderung an Tisch „${table.label}“`,
            { changes },
          );
        }
        if (keys.length === 0)
          return done(`Keine Änderung an Tisch „${table.label}“`, {
            table: compactTable(table),
          });
        const updated = await this.tables.updateTable(
          ctx.organizationId,
          tableId,
          dto,
          ctx.user,
        );
        return done(`Tisch „${updated.label}“ geändert: ${keys.join(', ')}`, {
          changes,
          table: compactTable(updated),
        });
      },
    });
  }
}
