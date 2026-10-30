import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  Category,
  PfandType,
  Product,
  ProductOptionGroup,
} from '../../../database/entities';
import { TokenScope } from '../../api-tokens/api-scopes';
import { CategoriesService } from '../../categories/categories.service';
import type { CreateCategoryDto, UpdateCategoryDto } from '../../categories/dto';
import { EventsService } from '../../events/events.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { PfandTypesService } from '../../pfand-types/pfand-types.service';
import type { CreatePfandTypeDto } from '../../pfand-types/dto';
import { ProductionStationsService } from '../../production-stations/production-stations.service';
import { ProductsService } from '../../products/products.service';
import type { CreateProductDto, UpdateProductDto } from '../../products/dto';
import { PRODUCT_ICON_PATTERN } from '../../products/dto/create-product.dto';
import {
  AgentToolError,
  defineTool,
  type AgentTool,
  type AgentToolContext,
} from '../agent-tool.types';
import {
  confirmInput,
  defined,
  diff,
  done,
  fetchAll,
  hexColor,
  listInput,
  money,
  notFound,
  preview,
  sameName,
  slice,
  uuid,
} from '../tool-helpers';
import { assertEvent } from './common';

export function compactCategory(category: Category) {
  return {
    id: category.id,
    name: category.name,
    parentId: category.parentId ?? null,
    color: category.color ?? null,
    icon: category.icon ?? null,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    productionStationId: category.productionStationId ?? null,
    productCount: category.products?.length ?? undefined,
  };
}

export function compactProduct(product: Product, includeOptions = false) {
  const groups = product.options?.groups ?? [];
  return {
    id: product.id,
    name: product.name,
    categoryId: product.categoryId,
    category: product.category?.name ?? null,
    price: money(product.price),
    taxRate: Number(product.taxRate ?? 0),
    pfandTypeId: product.pfandTypeId ?? null,
    icon: product.icon ?? null,
    description: product.description ?? null,
    isActive: product.isActive,
    isAvailable: product.isAvailable,
    isFavorite: product.isFavorite,
    trackInventory: product.trackInventory,
    stockQuantity: product.trackInventory ? product.stockQuantity : null,
    productionStationId: product.productionStationId ?? null,
    sortOrder: product.sortOrder,
    optionGroupCount: groups.length,
    ...(includeOptions ? { optionGroups: groups } : {}),
  };
}

export function compactPfandType(pfandType: PfandType) {
  return {
    id: pfandType.id,
    name: pfandType.name,
    amount: money(pfandType.amount),
    isActive: pfandType.isActive,
    sortOrder: pfandType.sortOrder,
  };
}

const optionGroupInput = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(['single', 'multiple', 'ingredients']).default('single'),
    required: z.boolean().default(false),
    options: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            priceModifier: z.number().default(0).describe('EUR, added to price'),
            default: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

const categoryFields = {
  name: z.string().min(2).max(255),
  description: z.string().max(1000).nullable(),
  parentId: uuid.nullable().describe('Parent category of the same event'),
  color: hexColor.nullable(),
  icon: z.string().max(50).nullable(),
  sortOrder: z.number().int().min(0),
  productionStationId: uuid.nullable().describe('Station of the same event'),
};

const productInput = z
  .object({
    id: uuid.optional().describe('Existing product to update; otherwise matched by exact name'),
    name: z.string().min(2).max(255),
    categoryId: uuid.optional(),
    category: z
      .string()
      .max(255)
      .optional()
      .describe('Category name (exact, case-insensitive) — alternative to categoryId'),
    price: z.number().min(0).optional().describe('Gross price in EUR; required for new products'),
    taxRate: z.number().min(0).max(100).optional().describe('Percent, e.g. 19 or 7'),
    description: z.string().max(2000).nullable().optional(),
    pfandTypeId: uuid.nullable().optional(),
    icon: z
      .string()
      .regex(PRODUCT_ICON_PATTERN)
      .nullable()
      .optional()
      .describe('e.g. pos-icon:<id> from suggest_icons'),
    isActive: z.boolean().optional(),
    isAvailable: z.boolean().optional(),
    isFavorite: z.boolean().optional(),
    trackInventory: z.boolean().optional(),
    stockQuantity: z.number().int().min(0).optional(),
    stockUnit: z.string().max(20).optional(),
    sortOrder: z.number().int().min(0).optional(),
    productionStationId: uuid.nullable().optional(),
    optionGroups: z.array(optionGroupInput).max(20).optional(),
  })
  .strict();

type ProductInput = z.infer<typeof productInput>;

interface UpsertPlan {
  create: Array<{ dto: CreateProductDto; categoryName: string | null }>;
  update: Array<{
    id: string;
    name: string;
    dto: UpdateProductDto;
    changes: Record<string, { from: unknown; to: unknown }>;
  }>;
  unchanged: string[];
  errors: Array<{ row: number; name: string; error: string }>;
  newCategories: string[];
}

@Injectable()
export class CatalogTools {
  constructor(
    private readonly events: EventsService,
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly pfandTypes: PfandTypesService,
    private readonly stations: ProductionStationsService,
    private readonly organizations: OrganizationsService,
  ) {}

  tools(): AgentTool[] {
    return [
      this.listCategories(),
      this.listProducts(),
      this.listPfandTypes(),
      this.createCategory(),
      this.updateCategory(),
      this.upsertProducts(),
      this.updateProductAvailability(),
      this.createPfandType(),
    ];
  }

  private listCategories() {
    return defineTool({
      name: 'list_categories',
      description: 'Categories of an event with product counts.',
      inputSchema: z.object({ eventId: uuid }).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        await assertEvent(this.events, ctx, input.eventId);
        const categories = await this.categories.findAll(input.eventId, ctx.user);
        return { items: categories.map(compactCategory), total: categories.length };
      },
    });
  }

  private listProducts() {
    return defineTool({
      name: 'list_products',
      description:
        'Products of an event (price in EUR, tax rate in percent). Filter by category or name; includeOptions adds variant/option groups.',
      inputSchema: z
        .object({
          eventId: uuid,
          categoryId: uuid.optional(),
          search: z.string().max(100).optional().describe('Substring of the name'),
          includeOptions: z.boolean().default(false),
          ...listInput,
        })
        .strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx, input) => {
        await assertEvent(this.events, ctx, input.eventId);
        let all = await fetchAll((p) =>
          this.products.findAll(input.eventId, ctx.user, p),
        );
        if (input.categoryId) {
          all = all.filter((p) => p.categoryId === input.categoryId);
        }
        if (input.search) {
          const needle = input.search.toLocaleLowerCase('de');
          all = all.filter((p) => p.name.toLocaleLowerCase('de').includes(needle));
        }
        const page = slice(all, input.offset, input.limit);
        return {
          ...page,
          items: page.items.map((p) => compactProduct(p, input.includeOptions)),
        };
      },
    });
  }

  private listPfandTypes() {
    return defineTool({
      name: 'list_pfand_types',
      description: 'Deposit (Pfand) types of the organization with amounts in EUR.',
      inputSchema: z.object({}).strict(),
      scope: TokenScope.READ,
      mutating: false,
      handler: async (ctx) => {
        const types = await this.pfandTypes.findAll(ctx.organizationId, ctx.user);
        return { items: types.map(compactPfandType), total: types.length };
      },
    });
  }

  private createCategory() {
    return defineTool({
      name: 'create_category',
      description: 'Create a category in an event.',
      inputSchema: z
        .object({
          eventId: uuid,
          name: categoryFields.name,
          description: categoryFields.description.optional(),
          parentId: categoryFields.parentId.optional(),
          color: categoryFields.color.optional(),
          icon: categoryFields.icon.optional(),
          sortOrder: categoryFields.sortOrder.optional(),
          productionStationId: categoryFields.productionStationId.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.CATALOG_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { eventId, confirm, ...rest } = input;
        const event = await assertEvent(this.events, ctx, eventId);
        const existing = await this.categories.findAll(eventId, ctx.user);
        await this.assertCategoryRefs(ctx, eventId, existing, rest);
        const dto = defined(rest) as CreateCategoryDto;
        const duplicate = existing.find((c) => sameName(c.name, dto.name));
        if (!confirm) {
          await this.organizations.checkPermission(ctx.organizationId, ctx.user, 'products');
          return preview(
            duplicate
              ? `Kategorie „${dto.name}“ gibt es in „${event.name}“ schon (${duplicate.id}) — würde trotzdem eine zweite anlegen`
              : `Würde Kategorie „${dto.name}“ in „${event.name}“ anlegen`,
            { wouldCreate: dto, existingId: duplicate?.id ?? null },
          );
        }
        const category = await this.categories.create(eventId, dto, ctx.user);
        return done(`Kategorie „${category.name}“ angelegt`, {
          category: compactCategory(category),
        });
      },
    });
  }

  private updateCategory() {
    return defineTool({
      name: 'update_category',
      description: 'Change a category (name, parent, color, icon, order, station, active).',
      inputSchema: z
        .object({
          eventId: uuid,
          categoryId: uuid,
          name: categoryFields.name.optional(),
          description: categoryFields.description.optional(),
          parentId: categoryFields.parentId.optional(),
          color: categoryFields.color.optional(),
          icon: categoryFields.icon.optional(),
          sortOrder: categoryFields.sortOrder.optional(),
          isActive: z.boolean().optional(),
          productionStationId: categoryFields.productionStationId.optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.CATALOG_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { eventId, categoryId, confirm, ...rest } = input;
        await assertEvent(this.events, ctx, eventId);
        const existing = await this.categories.findAll(eventId, ctx.user);
        const category = existing.find((c) => c.id === categoryId);
        if (!category) throw notFound('Kategorie', categoryId);
        if (rest.parentId === categoryId) {
          throw new AgentToolError('INVALID_INPUT', 'parentId: a category cannot be its own parent');
        }
        await this.assertCategoryRefs(ctx, eventId, existing, rest);
        const dto = defined(rest) as UpdateCategoryDto;
        const changes = diff(
          { ...compactCategory(category), description: category.description ?? null },
          dto as Record<string, unknown>,
        );
        const keys = Object.keys(changes);
        if (!confirm) {
          await this.organizations.checkPermission(ctx.organizationId, ctx.user, 'products');
          return preview(
            keys.length
              ? `Würde Kategorie „${category.name}“ ändern: ${keys.join(', ')}`
              : `Keine Änderung an Kategorie „${category.name}“`,
            { changes },
          );
        }
        if (keys.length === 0) {
          return done(`Keine Änderung an Kategorie „${category.name}“`, {
            category: compactCategory(category),
          });
        }
        const updated = await this.categories.update(eventId, categoryId, dto, ctx.user);
        return done(`Kategorie „${updated.name}“ geändert: ${keys.join(', ')}`, {
          changes,
          category: compactCategory(updated),
        });
      },
    });
  }

  private upsertProducts() {
    return defineTool({
      name: 'upsert_products',
      description:
        'Create or update up to 100 products of an event in one call. A row with id updates that product; otherwise a product with the exact same name (case-insensitive) is updated, else created. New products need price and categoryId or category (name). Set createMissingCategories to create categories named in `category` that do not exist yet. Without confirm: preview with counts and per-row errors; nothing is written if any row has an error.',
      inputSchema: z
        .object({
          eventId: uuid,
          products: z.array(productInput).min(1).max(100),
          createMissingCategories: z.boolean().default(false),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.CATALOG_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const event = await assertEvent(this.events, ctx, input.eventId);
        const plan = await this.planUpsert(ctx, input.eventId, input.products, input.createMissingCategories);
        const summary = `${plan.create.length} Produkte anlegen, ${plan.update.length} ändern` +
          ` (${plan.unchanged.length} unverändert, ${plan.errors.length} Fehler` +
          (plan.newCategories.length ? `, ${plan.newCategories.length} neue Kategorien` : '') +
          `) in „${event.name}“`;

        if (!input.confirm) {
          await this.organizations.checkPermission(ctx.organizationId, ctx.user, 'products');
          return preview(`Würde ${summary}`, {
            wouldCreate: plan.create.map(({ dto, categoryName }) => ({
              name: dto.name,
              category: categoryName,
              price: dto.price,
              taxRate: dto.taxRate ?? null,
            })),
            wouldUpdate: plan.update.map(({ id, name, changes }) => ({ id, name, changes })),
            unchanged: plan.unchanged,
            newCategories: plan.newCategories,
            errors: plan.errors,
          });
        }
        if (plan.errors.length > 0) {
          throw new AgentToolError(
            'INVALID_INPUT',
            `${plan.errors.length} Zeilen fehlerhaft — nichts geändert`,
            plan.errors,
          );
        }

        const categoryIds = new Map<string, string>();
        for (const name of plan.newCategories) {
          const category = await this.categories.create(input.eventId, { name }, ctx.user);
          categoryIds.set(name.toLocaleLowerCase('de'), category.id);
        }
        const created: Array<{ id: string; name: string }> = [];
        for (const { dto, categoryName } of plan.create) {
          const categoryId =
            dto.categoryId || categoryIds.get((categoryName ?? '').toLocaleLowerCase('de'));
          const product = await this.products.create(
            input.eventId,
            { ...dto, categoryId: categoryId as string },
            ctx.user,
          );
          created.push({ id: product.id, name: product.name });
        }
        const updated: Array<{ id: string; name: string }> = [];
        for (const { id, dto } of plan.update) {
          const product = await this.products.update(input.eventId, id, dto, ctx.user);
          updated.push({ id: product.id, name: product.name });
        }
        return done(
          `${created.length} Produkte angelegt, ${updated.length} geändert` +
            (plan.newCategories.length ? `, ${plan.newCategories.length} Kategorien angelegt` : '') +
            ` in „${event.name}“`,
          { created, updated, unchanged: plan.unchanged, newCategories: plan.newCategories },
        );
      },
    });
  }

  private async planUpsert(
    ctx: AgentToolContext,
    eventId: string,
    rows: ProductInput[],
    createMissingCategories: boolean,
  ): Promise<UpsertPlan> {
    const [categories, existing, pfandTypes, stations] = await Promise.all([
      this.categories.findAll(eventId, ctx.user),
      fetchAll((p) => this.products.findAll(eventId, ctx.user, p)),
      this.pfandTypes.findAll(ctx.organizationId, ctx.user),
      this.stations.findAll(eventId, ctx.user),
    ]);
    const plan: UpsertPlan = { create: [], update: [], unchanged: [], errors: [], newCategories: [] };
    const seen = new Set<string>();

    rows.forEach((row, index) => {
      const fail = (error: string) => plan.errors.push({ row: index + 1, name: row.name, error });
      const key = row.id ?? row.name.trim().toLocaleLowerCase('de');
      if (seen.has(key)) return fail('Doppelt in dieser Eingabe');
      seen.add(key);

      const target = row.id
        ? existing.find((p) => p.id === row.id)
        : existing.find((p) => sameName(p.name, row.name));
      if (row.id && !target) return fail('Produkt nicht gefunden');

      let categoryId: string | undefined;
      let categoryName: string | null = null;
      if (row.categoryId) {
        const category = categories.find((c) => c.id === row.categoryId);
        if (!category) return fail('categoryId gehört nicht zu dieser Veranstaltung');
        categoryId = category.id;
        categoryName = category.name;
      } else if (row.category) {
        const category = categories.find((c) => sameName(c.name, row.category!));
        if (category) {
          categoryId = category.id;
          categoryName = category.name;
        } else if (createMissingCategories) {
          categoryName = row.category.trim();
          if (!plan.newCategories.some((n) => sameName(n, categoryName!))) {
            plan.newCategories.push(categoryName);
          }
        } else {
          return fail(`Kategorie „${row.category}“ nicht gefunden (createMissingCategories?)`);
        }
      } else if (!target) {
        return fail('categoryId oder category nötig');
      }
      if (row.pfandTypeId && !pfandTypes.some((t) => t.id === row.pfandTypeId)) {
        return fail('pfandTypeId nicht gefunden');
      }
      if (row.productionStationId && !stations.some((s) => s.id === row.productionStationId)) {
        return fail('productionStationId gehört nicht zu dieser Veranstaltung');
      }

      const { id: _id, category: _category, optionGroups, ...fields } = row;
      const options = optionGroups
        ? { groups: optionGroups as ProductOptionGroup[] }
        : undefined;

      if (!target) {
        if (row.price === undefined) return fail('price nötig für neue Produkte');
        plan.create.push({
          dto: defined({ ...fields, categoryId, options }) as unknown as CreateProductDto,
          categoryName,
        });
        return;
      }

      const dto = defined({ ...fields, categoryId, options }) as unknown as UpdateProductDto;
      const before = {
        ...compactProduct(target, true),
        stockUnit: target.stockUnit,
        options: target.options,
      } as Record<string, unknown>;
      const changes = diff(before, dto as Record<string, unknown>);
      if (Object.keys(changes).length === 0) {
        plan.unchanged.push(target.name);
      } else {
        plan.update.push({ id: target.id, name: target.name, dto, changes });
      }
    });
    return plan;
  }

  private async assertCategoryRefs(
    ctx: AgentToolContext,
    eventId: string,
    categories: Category[],
    refs: { parentId?: string | null; productionStationId?: string | null },
  ): Promise<void> {
    if (refs.parentId && !categories.some((c) => c.id === refs.parentId)) {
      throw new AgentToolError('INVALID_INPUT', 'parentId gehört nicht zu dieser Veranstaltung');
    }
    if (refs.productionStationId) {
      const stations = await this.stations.findAll(eventId, ctx.user);
      if (!stations.some((s) => s.id === refs.productionStationId)) {
        throw new AgentToolError('INVALID_INPUT', 'productionStationId gehört nicht zu dieser Veranstaltung');
      }
    }
  }

  private updateProductAvailability() {
    return defineTool({
      name: 'update_product_availability',
      description: 'Mark a product as sold out (isAvailable false) or available again.',
      inputSchema: z
        .object({ eventId: uuid, productId: uuid, isAvailable: z.boolean(), ...confirmInput })
        .strict(),
      scope: TokenScope.CATALOG_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        await assertEvent(this.events, ctx, input.eventId);
        const product = await this.products.findOne(input.eventId, input.productId, ctx.user);
        const label = input.isAvailable ? 'verfügbar' : 'ausverkauft';
        if (product.isAvailable === input.isAvailable) {
          return done(`„${product.name}“ ist bereits ${label}`, { product: compactProduct(product) });
        }
        if (!input.confirm) {
          return preview(`Würde „${product.name}“ auf ${label} setzen`, {
            changes: { isAvailable: { from: product.isAvailable, to: input.isAvailable } },
          });
        }
        const updated = await this.products.updateAvailability(
          input.eventId,
          input.productId,
          input.isAvailable,
          ctx.user,
        );
        return done(`„${updated.name}“ ist jetzt ${label}`, { product: compactProduct(updated) });
      },
    });
  }

  private createPfandType() {
    return defineTool({
      name: 'create_pfand_type',
      description: 'Create a deposit (Pfand) type, e.g. "Becher" 2.00 EUR.',
      inputSchema: z
        .object({
          name: z.string().min(1).max(255),
          amount: z.number().min(0).multipleOf(0.01).describe('EUR'),
          isActive: z.boolean().optional(),
          sortOrder: z.number().int().min(0).optional(),
          ...confirmInput,
        })
        .strict(),
      scope: TokenScope.CATALOG_WRITE,
      mutating: true,
      handler: async (ctx, input) => {
        const { confirm, ...rest } = input;
        const dto = defined(rest) as CreatePfandTypeDto;
        const existing = await this.pfandTypes.findAll(ctx.organizationId, ctx.user);
        const duplicate = existing.find((t) => sameName(t.name, dto.name));
        if (!confirm) {
          await this.organizations.checkPermission(ctx.organizationId, ctx.user, 'pfand');
          return preview(
            duplicate
              ? `Pfandart „${dto.name}“ gibt es schon (${duplicate.id}, ${money(duplicate.amount)} €) — würde trotzdem eine zweite anlegen`
              : `Würde Pfandart „${dto.name}“ (${dto.amount.toFixed(2)} €) anlegen`,
            { wouldCreate: dto, existingId: duplicate?.id ?? null },
          );
        }
        const created = await this.pfandTypes.create(ctx.organizationId, dto, ctx.user);
        return done(`Pfandart „${created.name}“ angelegt`, { pfandType: compactPfandType(created) });
      },
    });
  }
}
