import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { Event, ProductionStation } from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { CategoriesService } from '../../categories/categories.service';
import { EventsService } from '../../events/events.service';
import type { CreateEventDto, UpdateEventDto } from '../../events/dto';
import { OrganizationsService } from '../../organizations/organizations.service';
import { ProductionStationsService } from '../../production-stations/production-stations.service';
import type {
  CreateProductionStationDto,
  UpdateProductionStationDto,
} from '../../production-stations/dto';
import { ProductsService } from '../../products/products.service';
import { defineTool, type AgentTool } from '../agent-tool.types';
import {
  confirmInput,
  dateInput,
  defined,
  diff,
  done,
  fetchAll,
  hexColor,
  isoDate,
  listInput,
  preview,
  slice,
  uuid,
} from '../tool-helpers';
import { assertEvent } from './common';

const eventSettingsInput = z
  .object({
    orderingMode: z
      .enum(['immediate', 'tab'])
      .optional()
      .describe('immediate = pay at order, tab = open tab per table'),
    orderNumberPrefix: z.string().max(10).optional(),
    tables: z
      .object({
        mode: z
          .enum(['none', 'free', 'predefined'])
          .describe(
            'none = counter only, free = any number, predefined = table areas',
          ),
        areaIds: z.array(uuid).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function compactEvent(event: Event) {
  const s = event.settings ?? {};
  return {
    id: event.id,
    name: event.name,
    status: event.status,
    startDate: isoDate(event.startDate),
    endDate: isoDate(event.endDate),
    billingStatus: event.billingStatus ?? 'none',
    orderingMode: s.orderingMode ?? null,
    tablesMode: s.tables?.mode ?? null,
    shopEnabled: s.shop?.enabled === true,
    copiedFromEventId: event.copiedFromEventId ?? null,
  };
}

function eventDetails(event: Event) {
  const s = event.settings ?? {};
  return {
    ...compactEvent(event),
    description: event.description ?? null,
    settings: {
      orderNumberPrefix: s.orderNumberPrefix ?? null,
      orderingMode: s.orderingMode ?? null,
      tables: s.tables ?? null,
      shop: s.shop ?? null,
    },
    createdAt: event.createdAt?.toISOString?.() ?? null,
  };
}

function compactStation(station: ProductionStation) {
  return {
    id: station.id,
    name: station.name,
    description: station.description ?? null,
    color: station.color ?? null,
    sortOrder: station.sortOrder,
    isActive: station.isActive,
    printerId: station.printerId ?? null,
    printerName: station.printer?.name ?? null,
    handoffStationId: station.handoffStationId ?? null,
  };
}

const stationFields = {
  name: z.string().min(2).max(255),
  description: z.string().max(1000).nullable(),
  color: hexColor.nullable(),
  sortOrder: z.number().int().min(0),
  printerId: uuid.nullable().describe('Existing printer of the organization'),
  handoffStationId: uuid
    .nullable()
    .describe('Station that takes over after this one (same event)'),
};

@Injectable()
export class EventTools {
  constructor(
    private readonly events: EventsService,
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly stations: ProductionStationsService,
    private readonly organizations: OrganizationsService,
  ) {}

  tools(): AgentTool[] {
    return [
      this.listEvents(),
      this.getEvent(),
      this.createEvent(),
      this.updateEvent(),
      this.copyEvent(),
      this.listStations(),
      this.createStation(),
      this.updateStation(),
    ];
  }

  private listEvents() {
    return defineTool({
      name: 'list_events',
      description:
        'List events of the organization (newest first). status: active = live, test = test mode, inactive = not activated.',
      inputSchema: z
        .object({
          status: z.enum(['active', 'inactive', 'test']).optional(),
          ...listInput,
        })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        const all = await fetchAll((p) =>
          this.events.findAll(ctx.organizationId, ctx.user, p),
        );
        const filtered = input.status
          ? all.filter((e) => e.status === input.status)
          : all;
        const page = slice(filtered, input.offset, input.limit);
        return { ...page, items: page.items.map(compactEvent) };
      },
    });
  }

  private getEvent() {
    return defineTool({
      name: 'get_event',
      description: 'One event with its settings (ordering mode, tables, shop).',
      inputSchema: z.object({ eventId: uuid }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) =>
        eventDetails(await assertEvent(this.events, ctx, input.eventId)),
    });
  }

  private createEvent() {
    return defineTool({
      name: 'create_event',
      description:
        'Create an event. It starts not activated (status inactive); activation, test mode and billing happen in the web app and are never done by this tool. Dates: YYYY-MM-DD; endDate defaults to startDate.',
      inputSchema: z
        .object({
          name: z.string().min(2).max(255),
          description: z.string().max(2000).optional(),
          startDate: dateInput,
          endDate: dateInput.optional(),
          settings: eventSettingsInput.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.EVENTS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...dto } = input;
        const span = dto.endDate
          ? `${dto.startDate} – ${dto.endDate}`
          : dto.startDate;
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(
            `Würde Veranstaltung „${dto.name}“ (${span}) anlegen — nicht freigeschaltet (Status inactive)`,
            { wouldCreate: dto },
          );
        }
        const event = await this.events.create(
          ctx.organizationId,
          dto as CreateEventDto,
          ctx.user,
        );
        return done(
          `Veranstaltung „${event.name}“ angelegt (Status inactive; Freischaltung und Testmodus in der Web-App)`,
          { event: compactEvent(event) },
        );
      },
    });
  }

  private updateEvent() {
    return defineTool({
      name: 'update_event',
      description:
        'Change name, description, dates or settings of an event. Settings are merged. Never changes status or billing.',
      inputSchema: z
        .object({
          eventId: uuid,
          name: z.string().min(2).max(255).optional(),
          description: z.string().max(2000).optional(),
          startDate: dateInput.optional(),
          endDate: dateInput.optional(),
          settings: eventSettingsInput.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.EVENTS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { eventId, confirm, ...rest } = input;
        const event = await assertEvent(this.events, ctx, eventId);
        const dto = defined(rest) as UpdateEventDto;
        const before: Record<string, unknown> = {
          name: event.name,
          description: event.description ?? null,
          startDate: isoDate(event.startDate),
          endDate: isoDate(event.endDate),
        };
        const after: Record<string, unknown> = {};
        for (const key of [
          'name',
          'description',
          'startDate',
          'endDate',
        ] as const) {
          if (dto[key] !== undefined) {
            after[key] =
              key === 'startDate' || key === 'endDate'
                ? isoDate(dto[key])
                : dto[key];
          }
        }
        if (dto.settings) {
          const current = (event.settings ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(dto.settings)) {
            before[`settings.${key}`] = current[key] ?? null;
            after[`settings.${key}`] = value;
          }
        }
        const changes = diff(before, after);
        const count = Object.keys(changes).length;
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(
            count
              ? `Würde Veranstaltung „${event.name}“ ändern: ${Object.keys(changes).join(', ')}`
              : `Keine Änderung an „${event.name}“`,
            { changes },
          );
        }
        if (count === 0) {
          return done(`Keine Änderung an „${event.name}“`, {
            event: compactEvent(event),
          });
        }
        const updated = await this.events.update(
          ctx.organizationId,
          eventId,
          dto,
          ctx.user,
        );
        return done(
          `Veranstaltung „${updated.name}“ geändert: ${Object.keys(changes).join(', ')}`,
          { changes, event: compactEvent(updated) },
        );
      },
    });
  }

  private copyEvent() {
    return defineTool({
      name: 'copy_event',
      description:
        'Copy categories and products from one event of this organization into another (e.g. last year into this year). Without categoryIds/productIds everything is copied. Tax rates, Pfand and station links are not copied — set them afterwards with upsert_products.',
      inputSchema: z
        .object({
          targetEventId: uuid,
          sourceEventId: uuid,
          categoryIds: z.array(uuid).max(200).optional(),
          productIds: z.array(uuid).max(500).optional(),
          copyStock: z.boolean().default(false),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.EVENTS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const [target, source] = await Promise.all([
          assertEvent(this.events, ctx, input.targetEventId),
          assertEvent(this.events, ctx, input.sourceEventId),
        ]);
        const dto = {
          categoryIds: input.categoryIds,
          productIds: input.productIds,
          copyStock: input.copyStock,
        };
        if (!input.confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          const [categories, products] = await Promise.all([
            this.categories.findAll(source.id, ctx.user),
            fetchAll((p) => this.products.findAll(source.id, ctx.user, p)),
          ]);
          const categoryCount = input.categoryIds?.length
            ? categories.filter((c) => input.categoryIds!.includes(c.id)).length
            : categories.length;
          const productCount = input.productIds?.length
            ? products.filter((p) => input.productIds!.includes(p.id)).length
            : products.length;
          return preview(
            `Würde ${categoryCount} Kategorien und ${productCount} Produkte von „${source.name}“ nach „${target.name}“ kopieren`,
            {
              source: compactEvent(source),
              target: compactEvent(target),
              categoryCount,
              productCount,
            },
          );
        }
        const result = await this.events.copyFromEvent(
          ctx.organizationId,
          target.id,
          source.id,
          dto,
          ctx.user,
        );
        return done(
          `${result.categoriesCopied} Kategorien und ${result.productsCopied} Produkte von „${source.name}“ nach „${target.name}“ kopiert`,
          result,
        );
      },
    });
  }

  private listStations() {
    return defineTool({
      name: 'list_production_stations',
      description:
        'Production stations (kitchen, grill, bar …) of an event with their printer.',
      inputSchema: z.object({ eventId: uuid }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        await assertEvent(this.events, ctx, input.eventId);
        const stations = await this.stations.findAll(input.eventId, ctx.user);
        return { items: stations.map(compactStation), total: stations.length };
      },
    });
  }

  private createStation() {
    return defineTool({
      name: 'create_production_station',
      description:
        'Create a production station for an event. printerId must be an existing printer of the organization (see list_printers).',
      inputSchema: z
        .object({
          eventId: uuid,
          name: stationFields.name,
          description: stationFields.description.optional(),
          color: stationFields.color.optional(),
          sortOrder: stationFields.sortOrder.optional(),
          printerId: stationFields.printerId.optional(),
          handoffStationId: stationFields.handoffStationId.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.EVENTS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { eventId, confirm, ...rest } = input;
        const event = await assertEvent(this.events, ctx, eventId);
        const dto = defined(rest) as CreateProductionStationDto;
        if (!confirm) {
          await this.organizations.checkPermission(
            ctx.organizationId,
            ctx.user,
            'events',
          );
          return preview(
            `Würde Station „${dto.name}“ in „${event.name}“ anlegen`,
            { wouldCreate: dto },
          );
        }
        const station = await this.stations.create(eventId, dto, ctx.user);
        return done(`Station „${station.name}“ angelegt`, {
          station: compactStation(station),
        });
      },
    });
  }

  private updateStation() {
    return defineTool({
      name: 'update_production_station',
      description:
        'Change a production station (name, printer, handoff, active).',
      inputSchema: z
        .object({
          eventId: uuid,
          stationId: uuid,
          name: stationFields.name.optional(),
          description: stationFields.description.optional(),
          color: stationFields.color.optional(),
          sortOrder: stationFields.sortOrder.optional(),
          isActive: z.boolean().optional(),
          printerId: stationFields.printerId.optional(),
          handoffStationId: stationFields.handoffStationId.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.EVENTS_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { eventId, stationId, confirm, ...rest } = input;
        await assertEvent(this.events, ctx, eventId);
        const station = await this.stations.findOne(
          eventId,
          stationId,
          ctx.user,
        );
        const dto = defined(rest) as UpdateProductionStationDto;
        const changes = diff(
          compactStation(station) as unknown as Record<string, unknown>,
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
              ? `Würde Station „${station.name}“ ändern: ${keys.join(', ')}`
              : `Keine Änderung an Station „${station.name}“`,
            { changes },
          );
        }
        if (keys.length === 0) {
          return done(`Keine Änderung an Station „${station.name}“`, {
            station: compactStation(station),
          });
        }
        const updated = await this.stations.update(
          eventId,
          stationId,
          dto,
          ctx.user,
        );
        return done(`Station „${updated.name}“ geändert: ${keys.join(', ')}`, {
          changes,
          station: compactStation(updated),
        });
      },
    });
  }
}
