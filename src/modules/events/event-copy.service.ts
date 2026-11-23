import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EntityManager, In } from 'typeorm';
import {
  Category,
  Event,
  Organization,
  Product,
  ProductionStation,
  Shift,
  ShiftJob,
  ShiftPlan,
  TableArea,
  TokenType,
} from '../../database/entities';
import { ShiftPlanStatus } from '../../database/entities/shift-plan.entity';
import type { EventSettings } from '../../database/entities/event.entity';
import { WaitersService } from '../waiters/waiters.service';

/**
 * Uebernahme aus einer anderen Veranstaltung derselben Organisation — ein
 * Dienst fuer alle Wege: neue Veranstaltung mit Vorlage, „Aus Veranstaltung
 * übernehmen“ auf der Produktseite, „Veranstaltung duplizieren“ und das
 * Assistenten-Werkzeug `copy_event`.
 *
 * Regeln:
 * - Reihenfolge Stationen → Kategorien → Produkte, je mit Zuordnung alt →
 *   neu; die Folgestation (`handoffStationId`) in einem zweiten Durchgang.
 * - Organisationsweite Bezuege (Pfandart, Drucker, Tischbereiche) behalten
 *   ihre ID.
 * - Gleichnamige Kategorien (ohne Gross-/Kleinschreibung, gleiche Ebene)
 *   und Stationen der Zielveranstaltung werden weiterverwendet statt
 *   verdoppelt. Ein Produkt, das es in der Zielkategorie schon gibt, wird
 *   uebersprungen, ausser `includeDuplicates`.
 * - Steuerbefreite Organisation (`settings.vatExempt` nicht ausdruecklich
 *   `false`): Steuersatz 0.
 * - Bilder bleiben Verweise: hochgeladene Dateien liegen je Organisation
 *   und werden mit einer Veranstaltung nicht geloescht.
 * - Alles laeuft in der Transaktion des Aufrufers (alles oder nichts).
 */

export interface CatalogCopyOptions {
  organizationId: string;
  sourceEventId: string;
  targetEventId: string;
  /** Kategorien (samt ihrer Produkte, wenn `productIds` fehlt). */
  categoryIds?: string[];
  /** Einzelne Produkte; ihre Kategorien kommen automatisch mit. */
  productIds?: string[];
  /** Bestand mitnehmen (Standard: 0). */
  copyStock?: boolean;
  /** Produkte auch dann anlegen, wenn es den Namen in der Kategorie schon gibt. */
  includeDuplicates?: boolean;
  /**
   * Alle Stationen der Quelle uebernehmen (neue bzw. duplizierte
   * Veranstaltung). Sonst nur die, auf die die gewaehlten Kategorien und
   * Produkte zeigen, samt ihrer Folgestationen.
   */
  allStations?: boolean;
}

export interface SkippedProduct {
  name: string;
  category: string;
}

export interface CatalogCopyResult {
  categoriesCopied: number;
  categoriesMerged: number;
  productsCopied: number;
  productsSkipped: number;
  skippedProducts: SkippedProduct[];
  stationsCopied: number;
  stationsMerged: number;
}

export interface CatalogCopyMaps {
  categories: Map<string, string>;
  products: Map<string, string>;
  stations: Map<string, string>;
}

/** Vergleichsschluessel fuer Namen: getrimmt, ohne Gross-/Kleinschreibung. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLocaleLowerCase('de-DE');
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayKeyToUtc(key: string): number | null {
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Abstand zweier Kalendertage ('YYYY-MM-DD') in Tagen. */
export function dayKeyDiff(from: string, to: string): number {
  const a = dayKeyToUtc(from);
  const b = dayKeyToUtc(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Kalendertag um `days` verschieben; Unlesbares bleibt, wie es ist. */
export function shiftDayKey(key: string, days: number): string {
  const utc = dayKeyToUtc(key);
  if (utc === null) return key;
  return new Date(utc + days * 86_400_000).toISOString().slice(0, 10);
}

/** Datum einer Schicht (`date`-Spalte: String oder Date) als Tag. */
export function toDayKeyValue(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Organisation steuerbefreit? Nur ein ausdrueckliches `false` ist es nicht. */
export function isVatExempt(
  organization: Pick<Organization, 'settings'> | null | undefined,
): boolean {
  return organization?.settings?.vatExempt !== false;
}

/**
 * Einstellungen einer duplizierten Veranstaltung: nur, was die Veranstaltung
 * beschreibt (Kassier- und Tischmodus, Vorlauf, Vorverkauf, Shop), nie
 * Abrechnung oder TSE. Shop-Oeffnungstage wandern um `offsetDays` mit und
 * fallen weg, wenn sie ausserhalb des neuen Zeitraums liegen.
 */
export function duplicateEventSettings(
  source: EventSettings | null | undefined,
  offsetDays: number,
  targetDayKeys: string[] | null,
  knownAreaIds: Set<string>,
): EventSettings {
  const settings: EventSettings = {};
  if (!source) return settings;
  const copyKeys = [
    'orderNumberPrefix',
    'orderingMode',
    'enableOnlineOrdering',
    'enableTableService',
    'enableTakeaway',
    'maxOrdersPerHour',
  ] as const;
  for (const key of copyKeys) {
    if (source[key] !== undefined) {
      (settings as Record<string, unknown>)[key] = source[key];
    }
  }
  if (source.tables) {
    const areaIds = Array.isArray(source.tables.areaIds)
      ? source.tables.areaIds.filter((id) => knownAreaIds.has(id))
      : null;
    settings.tables = {
      mode: source.tables.mode,
      // Alle Bereiche geloescht: dann wieder alle statt keiner.
      areaIds: areaIds && areaIds.length ? areaIds : null,
    };
  }
  if (source.sales) {
    settings.sales = { ...source.sales };
  }
  if (source.shop) {
    const shop = { ...source.shop };
    if (Array.isArray(source.shop.days)) {
      const allowed = targetDayKeys ? new Set(targetDayKeys) : null;
      shop.days = source.shop.days
        .map((day) => ({ ...day, date: shiftDayKey(day.date, offsetDays) }))
        .filter((day) => !allowed || allowed.has(day.date));
    }
    settings.shop = shop;
  }
  return settings;
}

@Injectable()
export class EventCopyService {
  private readonly logger = new Logger(EventCopyService.name);

  constructor(
    @Optional() private readonly moduleRef?: ModuleRef,
    /** Fuer Tests direkt; sonst ueber `moduleRef` (kein Modul-Import noetig). */
    @Optional() private readonly waitersService?: WaitersService,
  ) {}

  private get waiters(): WaitersService | undefined {
    if (this.waitersService) return this.waitersService;
    try {
      return this.moduleRef?.get(WaitersService, { strict: false });
    } catch {
      return undefined;
    }
  }

  /** Stationen, Kategorien und Produkte uebernehmen. */
  async copyCatalog(
    manager: EntityManager,
    options: CatalogCopyOptions,
  ): Promise<CatalogCopyResult & { maps: CatalogCopyMaps }> {
    const {
      organizationId,
      sourceEventId,
      targetEventId,
      copyStock = false,
      includeDuplicates = false,
      allStations = false,
    } = options;
    const categoryIds = options.categoryIds?.length
      ? new Set(options.categoryIds)
      : null;
    const productIds = options.productIds?.length
      ? new Set(options.productIds)
      : null;

    const categoryRepo = manager.getRepository(Category);
    const productRepo = manager.getRepository(Product);
    const stationRepo = manager.getRepository(ProductionStation);

    const organization = await manager
      .getRepository(Organization)
      .findOne({ where: { id: organizationId } });
    const vatExempt = isVatExempt(organization);

    // Nacheinander: alle Abfragen laufen ueber dieselbe Verbindung der
    // Transaktion.
    const order = { sortOrder: 'ASC', createdAt: 'ASC' } as const;
    const sourceCategories = await categoryRepo.find({
      where: { eventId: sourceEventId },
      order,
    });
    const sourceProducts = await productRepo.find({
      where: { eventId: sourceEventId },
      order,
    });
    const sourceStations = await stationRepo.find({
      where: { eventId: sourceEventId },
      order,
    });
    const sourceCategoryById = new Map(sourceCategories.map((c) => [c.id, c]));
    const sourceStationById = new Map(sourceStations.map((s) => [s.id, s]));

    // Auswahl: Produkte, dann die Kategorien, die sie brauchen.
    const selectedProducts = sourceProducts.filter((p) =>
      productIds
        ? productIds.has(p.id)
        : categoryIds
          ? categoryIds.has(p.categoryId)
          : true,
    );
    const selectedCategoryIds = new Set<string>();
    if (!categoryIds && !productIds) {
      for (const c of sourceCategories) selectedCategoryIds.add(c.id);
    } else {
      for (const id of categoryIds ?? []) {
        if (sourceCategoryById.has(id)) selectedCategoryIds.add(id);
      }
      for (const p of selectedProducts) selectedCategoryIds.add(p.categoryId);
      // Oberkategorien mitnehmen, sonst haengt die Unterkategorie in der Luft.
      for (const id of [...selectedCategoryIds]) {
        let parentId = sourceCategoryById.get(id)?.parentId ?? null;
        const seen = new Set<string>([id]);
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          if (!sourceCategoryById.has(parentId)) break;
          selectedCategoryIds.add(parentId);
          parentId = sourceCategoryById.get(parentId)?.parentId ?? null;
        }
      }
    }
    const selectedCategories = sourceCategories.filter((c) =>
      selectedCategoryIds.has(c.id),
    );

    // Stationen: alle oder die verwendeten samt Folgestationen.
    const stationIds = new Set<string>();
    if (allStations) {
      for (const s of sourceStations) stationIds.add(s.id);
    } else {
      for (const c of selectedCategories) {
        if (c.productionStationId) stationIds.add(c.productionStationId);
      }
      for (const p of selectedProducts) {
        if (p.productionStationId) stationIds.add(p.productionStationId);
      }
      const queue = [...stationIds];
      while (queue.length) {
        const next = sourceStationById.get(queue.pop()!)?.handoffStationId;
        if (next && !stationIds.has(next)) {
          stationIds.add(next);
          queue.push(next);
        }
      }
    }
    const selectedStations = sourceStations.filter((s) => stationIds.has(s.id));

    // Bestand der Zielveranstaltung (in der Transaktion gelesen: ein
    // zweiter, gleichzeitiger Aufruf wartet auf die Sperre des Aufrufers
    // und sieht danach die schon uebernommenen Eintraege).
    const targetCategories = await categoryRepo.find({
      where: { eventId: targetEventId },
    });
    const targetProducts = await productRepo.find({
      where: { eventId: targetEventId },
    });
    const targetStations = await stationRepo.find({
      where: { eventId: targetEventId },
    });

    const maps: CatalogCopyMaps = {
      categories: new Map(),
      products: new Map(),
      stations: new Map(),
    };
    const result: CatalogCopyResult = {
      categoriesCopied: 0,
      categoriesMerged: 0,
      productsCopied: 0,
      productsSkipped: 0,
      skippedProducts: [],
      stationsCopied: 0,
      stationsMerged: 0,
    };

    // 1. Stationen — erster Durchgang ohne Folgestation.
    const stationByName = new Map(
      targetStations.map((s) => [nameKey(s.name), s]),
    );
    const createdStations: Array<{ source: ProductionStation; id: string }> =
      [];
    for (const source of selectedStations) {
      const existing = stationByName.get(nameKey(source.name));
      if (existing) {
        maps.stations.set(source.id, existing.id);
        result.stationsMerged++;
        continue;
      }
      const station = await stationRepo.save(
        stationRepo.create({
          eventId: targetEventId,
          name: source.name,
          description: source.description,
          color: source.color,
          sortOrder: source.sortOrder,
          isActive: source.isActive,
          // Drucker gehoeren der Organisation: gleiche ID.
          printerId: source.printerId,
          handoffStationId: null,
        }),
      );
      stationByName.set(nameKey(station.name), station);
      maps.stations.set(source.id, station.id);
      createdStations.push({ source, id: station.id });
      result.stationsCopied++;
    }
    // Zweiter Durchgang: Folgestationen der neu angelegten.
    for (const { source, id } of createdStations) {
      if (!source.handoffStationId) continue;
      const handoff = maps.stations.get(source.handoffStationId);
      if (handoff && handoff !== id) {
        await stationRepo.update({ id }, { handoffStationId: handoff });
      }
    }

    // 2. Kategorien — Eltern vor Kindern.
    const depthOf = (category: Category): number => {
      let depth = 0;
      let parentId = category.parentId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        depth++;
        parentId = sourceCategoryById.get(parentId)?.parentId ?? null;
      }
      return depth;
    };
    const ordered = [...selectedCategories].sort(
      (a, b) => depthOf(a) - depthOf(b),
    );
    const categoryKey = (parentId: string | null, name: string) =>
      `${parentId ?? ''}|${nameKey(name)}`;
    const categoryByKey = new Map<string, Category>();
    for (const c of targetCategories) {
      const key = categoryKey(c.parentId, c.name);
      if (!categoryByKey.has(key)) categoryByKey.set(key, c);
    }
    const targetCategoryName = new Map(
      targetCategories.map((c) => [c.id, c.name]),
    );
    for (const source of ordered) {
      const parentId = source.parentId
        ? (maps.categories.get(source.parentId) ?? null)
        : null;
      const key = categoryKey(parentId, source.name);
      const existing = categoryByKey.get(key);
      if (existing) {
        maps.categories.set(source.id, existing.id);
        result.categoriesMerged++;
        continue;
      }
      const category = await categoryRepo.save(
        categoryRepo.create({
          eventId: targetEventId,
          parentId,
          name: source.name,
          description: source.description,
          color: source.color,
          icon: source.icon,
          sortOrder: source.sortOrder,
          isActive: source.isActive,
          printSettings: source.printSettings,
          productionStationId: source.productionStationId
            ? (maps.stations.get(source.productionStationId) ?? null)
            : null,
        }),
      );
      categoryByKey.set(key, category);
      targetCategoryName.set(category.id, category.name);
      maps.categories.set(source.id, category.id);
      result.categoriesCopied++;
    }

    // 3. Produkte. Doppelt ist nur, was vor dieser Uebernahme schon in der
    // Zielkategorie stand — zwei gleichnamige Produkte der Quelle kommen
    // beide mit.
    const existingProductKeys = new Set(
      targetProducts.map((p) => `${p.categoryId}|${nameKey(p.name)}`),
    );
    for (const source of selectedProducts) {
      const categoryId = maps.categories.get(source.categoryId);
      if (!categoryId) continue;
      if (
        !includeDuplicates &&
        existingProductKeys.has(`${categoryId}|${nameKey(source.name)}`)
      ) {
        result.productsSkipped++;
        result.skippedProducts.push({
          name: source.name,
          category: targetCategoryName.get(categoryId) ?? '',
        });
        continue;
      }
      const product = await productRepo.save(
        productRepo.create({
          eventId: targetEventId,
          categoryId,
          name: source.name,
          description: source.description,
          price: source.price,
          taxRate: vatExempt ? 0 : Number(source.taxRate ?? 0),
          imageUrl: source.imageUrl,
          icon: source.icon,
          isFavorite: source.isFavorite,
          isActive: source.isActive,
          isAvailable: source.isAvailable,
          trackInventory: source.trackInventory,
          stockQuantity: copyStock ? source.stockQuantity : 0,
          stockUnit: source.stockUnit,
          options: source.options,
          printSettings: source.printSettings,
          sortOrder: source.sortOrder,
          productionStationId: source.productionStationId
            ? (maps.stations.get(source.productionStationId) ?? null)
            : null,
          // Pfandarten gehoeren der Organisation: gleiche ID.
          pfandTypeId: source.pfandTypeId,
        }),
      );
      maps.products.set(source.id, product.id);
      result.productsCopied++;
    }

    this.logger.log(
      `Catalog copy ${sourceEventId} -> ${targetEventId}: stations +${result.stationsCopied}/=${result.stationsMerged}, categories +${result.categoriesCopied}/=${result.categoriesMerged}, products +${result.productsCopied}/skip ${result.productsSkipped}`,
    );

    return { ...result, maps };
  }

  /**
   * Wertmarken, die nur fuer die Quelle gelten. Erlaubte Kategorien und
   * Produkte zeigen danach auf die Kopien; was nicht mitkam, faellt weg.
   */
  async copyEventTokenTypes(
    manager: EntityManager,
    organizationId: string,
    sourceEventId: string,
    targetEventId: string,
    maps: CatalogCopyMaps,
  ): Promise<number> {
    const repo = manager.getRepository(TokenType);
    const sources = await repo.find({
      where: { organizationId, eventId: sourceEventId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    const remap = (
      ids: string[] | null | undefined,
      map: Map<string, string>,
    ) =>
      (ids ?? []).map((id) => map.get(id)).filter((id): id is string => !!id);
    for (const source of sources) {
      await repo.save(
        repo.create({
          organizationId,
          eventId: targetEventId,
          name: source.name,
          value: source.value,
          kind: source.kind,
          vatRate: source.vatRate,
          allowedCategoryIds: remap(source.allowedCategoryIds, maps.categories),
          allowedProductIds: remap(source.allowedProductIds, maps.products),
          color: source.color,
          buybackAllowed: source.buybackAllowed,
          isActive: source.isActive,
          sortOrder: source.sortOrder,
        }),
      );
    }
    return sources.length;
  }

  /**
   * Schichtplaene der Quelle: Aufgaben und Schichten, Daten um
   * `offsetDays` verschoben. Ohne Anmeldungen und Helfer, als Entwurf.
   */
  async copyEventShiftPlans(
    manager: EntityManager,
    organizationId: string,
    source: Pick<Event, 'id' | 'name'>,
    target: Pick<Event, 'id' | 'name'>,
    offsetDays: number,
  ): Promise<{ plans: number; shifts: number }> {
    const planRepo = manager.getRepository(ShiftPlan);
    const jobRepo = manager.getRepository(ShiftJob);
    const shiftRepo = manager.getRepository(Shift);
    const plans = await planRepo.find({
      where: { organizationId, eventId: source.id },
      order: { createdAt: 'ASC' },
    });
    let shiftCount = 0;
    for (const plan of plans) {
      const name =
        source.name && plan.name.includes(source.name)
          ? plan.name.split(source.name).join(target.name)
          : plan.name;
      const copy = await planRepo.save(
        planRepo.create({
          organizationId,
          eventId: target.id,
          name: name.slice(0, 255),
          description: plan.description,
          publicSlug: await this.freeSlug(manager, name),
          status: ShiftPlanStatus.DRAFT,
          settings: { ...plan.settings },
        }),
      );
      const jobs = await jobRepo.find({
        where: { shiftPlanId: plan.id },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
      for (const job of jobs) {
        const jobCopy = await jobRepo.save(
          jobRepo.create({
            shiftPlanId: copy.id,
            name: job.name,
            description: job.description,
            color: job.color,
            sortOrder: job.sortOrder,
            requiredWorkers: job.requiredWorkers,
          }),
        );
        const shifts = await shiftRepo.find({
          where: { shiftJobId: job.id },
          order: { date: 'ASC', startTime: 'ASC' },
        });
        if (!shifts.length) continue;
        await shiftRepo.save(
          shifts.map((shift) =>
            shiftRepo.create({
              shiftJobId: jobCopy.id,
              date: shiftDayKey(
                toDayKeyValue(shift.date),
                offsetDays,
              ) as unknown as Date,
              startTime: shift.startTime,
              endTime: shift.endTime,
              requiredWorkers: shift.requiredWorkers,
              notes: shift.notes,
            }),
          ),
        );
        shiftCount += shifts.length;
      }
    }
    return { plans: plans.length, shifts: shiftCount };
  }

  /** Bedienungen nur dieser Veranstaltung, mit neuen PINs. */
  async copyEventWaiters(
    manager: EntityManager,
    organizationId: string,
    sourceEventId: string,
    targetEventId: string,
    userId: string,
  ) {
    if (!this.waiters) return [];
    return this.waiters.copyEventWaiters(
      manager,
      organizationId,
      sourceEventId,
      targetEventId,
      userId,
    );
  }

  /** Darf der Nutzer Bedienungen verwalten (Admin oder Recht „Bedienungen“)? */
  async canManageWaiters(
    organizationId: string,
    user: { id: string },
  ): Promise<boolean> {
    return this.waiters ? this.waiters.canManage(organizationId, user) : false;
  }

  /** Protokoll der uebernommenen Bedienungen. */
  async auditCopiedWaiters(
    organizationId: string,
    user: { id: string },
    details: { count: number; eventId: string; sourceEventId: string },
  ): Promise<void> {
    await this.waiters?.auditCopiedWaiters(organizationId, user, details);
  }

  /** Bereiche der Organisation (fuer `settings.tables.areaIds`). */
  async knownAreaIds(
    manager: EntityManager,
    organizationId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const areas = await manager.getRepository(TableArea).find({
      where: { organizationId, id: In(ids) },
      select: { id: true },
    });
    return new Set(areas.map((a) => a.id));
  }

  private async freeSlug(
    manager: EntityManager,
    name: string,
  ): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[äÄ]/g, 'ae')
        .replace(/[öÖ]/g, 'oe')
        .replace(/[üÜ]/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'schichtplan';
    const repo = manager.getRepository(ShiftPlan);
    for (let attempt = 0; attempt < 10; attempt++) {
      const slug = `${base}-${Math.random().toString(36).substring(2, 6)}`;
      if ((await repo.count({ where: { publicSlug: slug } })) === 0)
        return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}
