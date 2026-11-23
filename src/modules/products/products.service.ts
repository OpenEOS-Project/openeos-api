import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Product,
  User,
  UserOrganization,
  StockMovement,
  Event,
  Category,
  PfandType,
} from '../../database/entities';
import { Organization } from '../../database/entities/organization.entity';
import { taxRatesFor } from '../../common/constants/tax-rates';
import { StockMovementType } from '../../database/entities/stock-movement.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PaginationDto,
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import { CreateProductDto, UpdateProductDto, AdjustStockDto } from './dto';
import { ImportProductsDto } from './dto/import-products.dto';
import { parseProductCsv, serializeProductCsv } from './product-csv';
import {
  assertReferencesInOrganization,
  type ReferenceCheck,
} from '../../common/utils/organization-references';
import { GatewayService } from '../gateway/gateway.service';

/** Ein geprueftes Paket fuer `upsertMany`. */
export interface ProductUpsertBatch {
  /** Neue Kategorien (Namen); Produkte verweisen ueber `categoryName` darauf. */
  newCategories: string[];
  create: Array<{ dto: CreateProductDto; categoryName?: string | null }>;
  update: Array<{ id: string; dto: UpdateProductDto }>;
}

function assertTaxRateIn(allowed: number[], taxRate: number): void {
  if (!allowed.includes(Number(taxRate))) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.TAX_RATE_NOT_ALLOWED,
      message: `Steuersatz ${taxRate} % ist für diese Organisation nicht zulässig`,
      params: { rate: taxRate },
    });
  }
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  async create(
    eventId: string,
    createDto: CreateProductDto,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );
    await this.assertTaxRateAllowed(event.organizationId, createDto.taxRate);
    await this.assertReferences(event, [createDto]);

    const product = this.productRepository.create({
      eventId: event.id,
      ...createDto,
    });

    await this.productRepository.save(product);
    this.logger.log(`Product created: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  async findAll(
    eventId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Product>> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const { page = 1, limit = 50 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.productRepository.findAndCount({
      where: { eventId },
      relations: ['category'],
      skip,
      take: limit,
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(
    eventId: string,
    productId: string,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckMembership(eventId, user.id);

    const product = await this.productRepository.findOne({
      where: { id: productId, eventId },
      relations: ['category'],
    });

    if (!product) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.PRODUCT_NOT_FOUND,
        message: 'Produkt nicht gefunden',
      });
    }

    return product;
  }

  async update(
    eventId: string,
    productId: string,
    updateDto: UpdateProductDto,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );
    await this.assertTaxRateAllowed(event.organizationId, updateDto.taxRate);
    await this.assertReferences(event, [updateDto]);

    const product = await this.findOne(eventId, productId, user);
    Object.assign(product, updateDto);
    // findOne eager-loads the `category` relation. On save, TypeORM derives the
    // FK from that (stale) relation object and would overwrite a changed
    // categoryId — so drop it and let the FK column win.
    delete (product as { category?: unknown }).category;
    await this.productRepository.save(product);

    this.logger.log(`Product updated: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  /**
   * Viele Produkte auf einmal anlegen und aendern — alles oder nichts.
   *
   * Erst wird alles geprueft (Berechtigung, Steuersaetze, Kategorien),
   * dann in einer Transaktion geschrieben: neue Kategorien, neue
   * Produkte, Aenderungen. Scheitert eine Zeile, bleibt der Bestand wie
   * vorher. Fuer `upsert_products` der Agenten; die Anzeigen bekommen
   * danach ein einziges `menuRefresh`.
   */
  async upsertMany(
    eventId: string,
    batch: ProductUpsertBatch,
    user: User,
  ): Promise<{
    categories: Category[];
    created: Product[];
    updated: Product[];
  }> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );
    const rates = [...batch.create, ...batch.update]
      .map(({ dto }) => dto.taxRate)
      .filter((rate): rate is number => rate !== undefined);
    if (rates.length > 0) {
      const allowed = await this.allowedTaxRates(event.organizationId);
      for (const rate of rates) assertTaxRateIn(allowed, rate);
    }
    // Kategorien prueft die Transaktion (dort entstehen auch neue);
    // Pfand-Typ und Station muessen schon vorher passen.
    await this.assertReferences(
      event,
      [...batch.create, ...batch.update].map(({ dto }) => ({
        pfandTypeId: dto.pfandTypeId,
        productionStationId: dto.productionStationId,
      })),
    );

    const key = (name: string) => name.trim().toLocaleLowerCase('de');
    const result = await this.productRepository.manager.transaction(
      async (manager) => {
        const categoryRepo = manager.getRepository(Category);
        const productRepo = manager.getRepository(Product);

        const known = new Set(
          (await categoryRepo.find({ where: { eventId } })).map((c) => c.id),
        );
        const assertCategory = (categoryId: string | undefined) => {
          if (categoryId && !known.has(categoryId)) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.CATEGORY_NOT_FOUND,
              message: 'Kategorie gehört nicht zu diesem Event',
              params: { categoryId },
            });
          }
        };

        const categories: Category[] = [];
        const newCategoryIds = new Map<string, string>();
        for (const name of batch.newCategories) {
          const category = await categoryRepo.save(
            categoryRepo.create({ eventId, name: name.trim() }),
          );
          categories.push(category);
          known.add(category.id);
          newCategoryIds.set(key(name), category.id);
        }

        const created: Product[] = [];
        for (const { dto, categoryName } of batch.create) {
          const categoryId =
            dto.categoryId ||
            (categoryName ? newCategoryIds.get(key(categoryName)) : undefined);
          if (!categoryId) {
            throw new BadRequestException({
              code: ErrorCodes.VALIDATION_ERROR,
              reason: ErrorReasons.CATEGORY_NOT_FOUND,
              message: `Keine Kategorie für „${dto.name}“`,
            });
          }
          assertCategory(categoryId);
          created.push(
            await productRepo.save(
              productRepo.create({ ...dto, eventId: event.id, categoryId }),
            ),
          );
        }

        const updated: Product[] = [];
        for (const { id, dto } of batch.update) {
          assertCategory(dto.categoryId);
          const product = await productRepo.findOne({
            where: { id, eventId },
          });
          if (!product) {
            throw new NotFoundException({
              code: ErrorCodes.NOT_FOUND,
              reason: ErrorReasons.PRODUCT_NOT_FOUND,
              message: 'Produkt nicht gefunden',
              params: { productId: id },
            });
          }
          Object.assign(product, dto);
          updated.push(await productRepo.save(product));
        }
        return { categories, created, updated };
      },
    );

    this.logger.log(
      `Products upserted for event ${eventId}: +${result.created.length} ~${result.updated.length} categories +${result.categories.length}`,
    );
    // Erst nach dem Commit: die Anzeigen laden die Karte neu.
    this.gatewayService.notifyMenuRefresh(
      event.organizationId,
      eventId,
      'product-upsert',
    );
    return result;
  }

  /**
   * Kategorie und Produktionsstandort gehoeren zur selben Veranstaltung,
   * der Pfand-Typ zur selben Organisation.
   */
  private async assertReferences(
    event: Event,
    dtos: readonly {
      categoryId?: string | null;
      pfandTypeId?: string | null;
      productionStationId?: string | null;
    }[],
  ): Promise<void> {
    const collect = (pick: (dto: (typeof dtos)[number]) => unknown) =>
      dtos
        .map(pick)
        .filter((id): id is string => typeof id === 'string' && id !== '');
    const checks: ReferenceCheck[] = [
      {
        kind: 'category',
        ids: collect((d) => d.categoryId),
        field: 'categoryId',
      },
      {
        kind: 'pfandType',
        ids: collect((d) => d.pfandTypeId),
        field: 'pfandTypeId',
      },
      {
        kind: 'productionStation',
        ids: collect((d) => d.productionStationId),
        field: 'productionStationId',
      },
    ];
    await assertReferencesInOrganization(
      this.productRepository.manager,
      { organizationId: event.organizationId, eventId: event.id },
      checks,
    );
  }

  async remove(eventId: string, productId: string, user: User): Promise<void> {
    const event = await this.getEventAndCheckAdmin(eventId, user.id);

    const product = await this.findOne(eventId, productId, user);
    await this.productRepository.softRemove(product);

    this.logger.log(`Product deleted: ${product.name} (${product.id})`);

    // Notify menu displays
    this.gatewayService.notifyProductDeleted(
      event.organizationId,
      eventId,
      productId,
    );
  }

  async updateAvailability(
    eventId: string,
    productId: string,
    isAvailable: boolean,
    user: User,
  ): Promise<Product> {
    const event = await this.getEventAndCheckMembership(eventId, user.id);

    const product = await this.findOne(eventId, productId, user);
    product.isAvailable = isAvailable;
    await this.productRepository.save(product);

    this.logger.log(
      `Product availability updated: ${product.name} - ${isAvailable}`,
    );

    // Notify menu displays
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.trackInventory ? product.stockQuantity : undefined,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  async adjustStock(
    eventId: string,
    productId: string,
    adjustDto: AdjustStockDto,
    user: User,
  ): Promise<Product> {
    await this.getEventAndCheckPermission(eventId, user.id, 'products');

    const product = await this.findOne(eventId, productId, user);

    if (!product.trackInventory) {
      throw new ForbiddenException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.PRODUCT_STOCK_NOT_TRACKED,
        message: 'Dieses Produkt hat keine Bestandsverfolgung',
      });
    }

    const previousQuantity = product.stockQuantity;
    product.stockQuantity += adjustDto.quantity;
    if (product.stockQuantity < 0) product.stockQuantity = 0;

    await this.productRepository.save(product);

    // Create stock movement record
    const stockMovement = this.stockMovementRepository.create({
      productId: product.id,
      eventId,
      quantity: adjustDto.quantity,
      quantityBefore: previousQuantity,
      quantityAfter: product.stockQuantity,
      reason: adjustDto.reason || 'Manuelle Anpassung',
      type:
        adjustDto.quantity > 0
          ? StockMovementType.ADJUSTMENT_PLUS
          : StockMovementType.ADJUSTMENT_MINUS,
      createdByUserId: user.id,
    });
    await this.stockMovementRepository.save(stockMovement);

    this.logger.log(
      `Stock adjusted for product ${product.id}: ${adjustDto.quantity}`,
    );

    // Notify menu displays about stock change
    const event = await this.getEvent(eventId);
    this.gatewayService.notifyProductUpdated(event.organizationId, eventId, {
      id: product.id,
      name: product.name,
      categoryId: product.categoryId,
      price: Number(product.price),
      isAvailable: product.isAvailable,
      isActive: product.isActive,
      stockQuantity: product.stockQuantity,
      trackInventory: product.trackInventory,
    });

    return product;
  }

  async getLowStock(eventId: string, user: User): Promise<Product[]> {
    await this.getEventAndCheckMembership(eventId, user.id);

    // Using raw query since TypeORM doesn't easily handle comparing two columns
    return this.productRepository
      .createQueryBuilder('product')
      .where('product.eventId = :eventId', { eventId })
      .andWhere('product.trackInventory = true')
      .andWhere('product.lowStockThreshold IS NOT NULL')
      .andWhere('product.stockQuantity <= product.lowStockThreshold')
      .andWhere('product.deletedAt IS NULL')
      .getMany();
  }

  /**
   * Import products from a CSV. With dryRun (default) nothing is written and a
   * preview is returned; otherwise categories/pfand-types are created as
   * needed and products are created/updated/skipped per `mode`.
   */
  async importProducts(
    eventId: string,
    dto: ImportProductsDto,
    user: User,
  ): Promise<{
    committed: boolean;
    summary: { create: number; update: number; skip: number; error: number };
    rows: Array<{
      line: number;
      name: string;
      category: string;
      price: number;
      pfand: number | null;
      icon: string | null;
      action: 'create' | 'update' | 'skip' | 'error';
      message?: string;
    }>;
    newCategories: string[];
    newPfandTypes: Array<{ name: string; amount: number }>;
    fatalError: string | null;
  }> {
    const event = await this.getEventAndCheckPermission(
      eventId,
      user.id,
      'products',
    );
    const mode = dto.mode ?? 'skip';
    const dryRun = dto.dryRun ?? true;

    const parsed = parseProductCsv(dto.csv);
    if (parsed.fatalError) {
      return {
        committed: false,
        summary: { create: 0, update: 0, skip: 0, error: 0 },
        rows: [],
        newCategories: [],
        newPfandTypes: [],
        fatalError: parsed.fatalError,
      };
    }

    // Existing state for matching (case-insensitive by name).
    const existingCategories = await this.categoryRepository.find({
      where: { eventId },
    });
    const categoryByName = new Map(
      existingCategories.map((c) => [c.name.trim().toLowerCase(), c]),
    );
    const existingProducts = await this.productRepository.find({
      where: { eventId },
    });
    const categoryNameById = new Map(
      existingCategories.map((c) => [c.id, c.name]),
    );
    const productKey = (name: string, categoryName: string) =>
      `${name.trim().toLowerCase()}|${categoryName.trim().toLowerCase()}`;
    const productByKey = new Map(
      existingProducts.map((p) => [
        productKey(p.name, categoryNameById.get(p.categoryId) ?? ''),
        p,
      ]),
    );
    const existingPfand = await this.pfandTypeRepository.find({
      where: { organizationId: event.organizationId },
    });
    const roundAmount = (a: number) => Math.round(a * 100) / 100;
    const pfandByAmount = new Map(
      existingPfand.map((p) => [roundAmount(Number(p.amount)), p]),
    );
    // Steuersatz-Spalte (optional): nur Saetze, die die Organisation fuehren darf.
    const allowedRates = parsed.rows.some((row) => row.taxRate !== null)
      ? await this.allowedTaxRates(event.organizationId)
      : [];
    for (const row of parsed.rows) {
      if (
        !row.error &&
        row.taxRate !== null &&
        !allowedRates.includes(Number(row.taxRate))
      ) {
        row.error = `Steuersatz ${row.taxRate} % ist für diese Organisation nicht zulässig`;
      }
    }

    // Collect new categories/pfand the import would introduce (preview + plan).
    const newCategoryNames: string[] = [];
    const seenNewCategory = new Set<string>();
    const newPfandAmounts: number[] = [];
    const seenNewPfand = new Set<number>();

    const plan = parsed.rows.map((row) => {
      let action: 'create' | 'update' | 'skip' | 'error';
      let message: string | undefined;

      if (row.error) {
        action = 'error';
        message = row.error;
      } else {
        const catKey = row.category.trim().toLowerCase();
        if (!categoryByName.has(catKey) && !seenNewCategory.has(catKey)) {
          seenNewCategory.add(catKey);
          newCategoryNames.push(row.category.trim());
        }
        if (row.pfand !== null) {
          const amt = roundAmount(row.pfand);
          if (!pfandByAmount.has(amt) && !seenNewPfand.has(amt)) {
            seenNewPfand.add(amt);
            newPfandAmounts.push(amt);
          }
        }
        const existing = productByKey.get(productKey(row.name, row.category));
        if (existing) {
          action =
            mode === 'skip' ? 'skip' : mode === 'update' ? 'update' : 'create';
          if (mode === 'skip') message = 'Existiert bereits';
        } else {
          action = 'create';
        }
      }

      return { row, action, message };
    });

    const summary = {
      create: plan.filter((p) => p.action === 'create').length,
      update: plan.filter((p) => p.action === 'update').length,
      skip: plan.filter((p) => p.action === 'skip').length,
      error: plan.filter((p) => p.action === 'error').length,
    };

    const pfandName = (amount: number) =>
      `Pfand ${amount.toFixed(2).replace('.', ',')} €`;

    if (!dryRun && (summary.create > 0 || summary.update > 0)) {
      // 1. Create missing categories (sortOrder appended).
      let nextSort =
        existingCategories.reduce((max, c) => Math.max(max, c.sortOrder), -1) +
        1;
      for (const name of newCategoryNames) {
        const cat = await this.categoryRepository.save(
          this.categoryRepository.create({
            eventId,
            name,
            sortOrder: nextSort++,
          }),
        );
        categoryByName.set(name.trim().toLowerCase(), cat);
      }

      // 2. Create missing pfand types.
      let nextPfandSort =
        existingPfand.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
      for (const amount of newPfandAmounts) {
        const pf = await this.pfandTypeRepository.save(
          this.pfandTypeRepository.create({
            organizationId: event.organizationId,
            name: pfandName(amount),
            amount,
            sortOrder: nextPfandSort++,
          }),
        );
        pfandByAmount.set(amount, pf);
      }

      // 3. Apply product creates/updates.
      for (const { row, action } of plan) {
        if (action !== 'create' && action !== 'update') continue;
        const category = categoryByName.get(row.category.trim().toLowerCase());
        if (!category) continue; // defensive; should exist after step 1
        const pfandTypeId =
          row.pfand !== null
            ? (pfandByAmount.get(roundAmount(row.pfand))?.id ?? null)
            : null;
        // `oe:<name>` ist ein Linien-Symbol (Spalte `icon`), alles andere
        // eine pos-icon-ID (Bild).
        const lineIcon = row.iconId?.startsWith('oe:') ? row.iconId : null;
        const imageUrl =
          row.iconId && !lineIcon ? `pos-icon:${row.iconId}` : null;

        if (action === 'create') {
          await this.productRepository.save(
            this.productRepository.create({
              eventId,
              categoryId: category.id,
              name: row.name,
              description: row.description,
              price: row.price,
              options: row.options,
              pfandTypeId,
              imageUrl,
              icon: lineIcon,
              ...(row.taxRate !== null ? { taxRate: row.taxRate } : {}),
              isAvailable: row.isAvailable,
              trackInventory: row.trackInventory,
              stockQuantity: row.stockQuantity,
              ...(row.sortOrder !== null ? { sortOrder: row.sortOrder } : {}),
            }),
          );
        } else {
          const existing = productByKey.get(productKey(row.name, row.category));
          if (!existing) continue;
          existing.categoryId = category.id;
          existing.description = row.description;
          existing.price = row.price;
          existing.options = row.options;
          existing.pfandTypeId = pfandTypeId;
          // Leere Spalte laesst Symbol und Foto stehen (ein Foto passt nicht
          // in die CSV und ginge beim Wiedereinlesen sonst verloren).
          if (row.iconId) {
            existing.imageUrl = imageUrl;
            existing.icon = lineIcon;
          }
          if (row.taxRate !== null) existing.taxRate = row.taxRate;
          existing.isAvailable = row.isAvailable;
          if (row.sortOrder !== null) existing.sortOrder = row.sortOrder;
          await this.productRepository.save(existing);
        }
      }

      this.gatewayService.notifyMenuRefresh(
        event.organizationId,
        eventId,
        'product-import',
      );
      this.logger.log(
        `Product import for event ${eventId}: +${summary.create} ~${summary.update} (by ${user.email})`,
      );
    }

    return {
      committed: !dryRun && (summary.create > 0 || summary.update > 0),
      summary,
      rows: plan.map(({ row, action, message }) => ({
        line: row.line,
        name: row.name,
        category: row.category,
        price: row.price,
        pfand: row.pfand,
        icon: row.iconId,
        action,
        message,
      })),
      newCategories: newCategoryNames,
      newPfandTypes: newPfandAmounts.map((amount) => ({
        name: pfandName(amount),
        amount,
      })),
      fatalError: null,
    };
  }

  /**
   * Produkte als CSV im Format des Imports (Rundreise): Kategorie (bei
   * Unterkategorien deren Name), Preis, Steuersatz, Pfand (Betrag der
   * Pfandart), Symbol, Optionen, Verfuegbarkeit, Bestand, Reihenfolge.
   */
  async exportProducts(
    eventId: string,
    user: User,
  ): Promise<{ filename: string; csv: string }> {
    const event = await this.getEventAndCheckMembership(eventId, user.id);
    const [categories, products, pfandTypes] = await Promise.all([
      this.categoryRepository.find({ where: { eventId } }),
      this.productRepository.find({
        where: { eventId },
        order: { sortOrder: 'ASC', name: 'ASC' },
      }),
      this.pfandTypeRepository.find({
        where: { organizationId: event.organizationId },
      }),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const pfandById = new Map(pfandTypes.map((p) => [p.id, Number(p.amount)]));
    const categorySort = (id: string) => {
      const c = categoryById.get(id);
      const parent = c?.parentId ? categoryById.get(c.parentId) : null;
      return [parent?.sortOrder ?? c?.sortOrder ?? 0, c?.sortOrder ?? 0];
    };
    const sorted = [...products].sort((a, b) => {
      const [pa, ca] = categorySort(a.categoryId);
      const [pb, cb] = categorySort(b.categoryId);
      return pa - pb || ca - cb || a.sortOrder - b.sortOrder;
    });
    const csv = serializeProductCsv(
      sorted.map((p) => ({
        category: categoryById.get(p.categoryId)?.name ?? '',
        name: p.name,
        description: p.description,
        price: Number(p.price),
        taxRate:
          p.taxRate === null || p.taxRate === undefined
            ? null
            : Number(p.taxRate),
        pfand: p.pfandTypeId ? (pfandById.get(p.pfandTypeId) ?? null) : null,
        imageUrl: p.imageUrl,
        icon: p.icon,
        options: p.options,
        isAvailable: p.isAvailable,
        trackInventory: p.trackInventory,
        stockQuantity: p.stockQuantity,
        sortOrder: p.sortOrder,
      })),
    );
    const slug =
      event.name
        .toLowerCase()
        .replace(/[äÄ]/g, 'ae')
        .replace(/[öÖ]/g, 'oe')
        .replace(/[üÜ]/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'veranstaltung';
    return { filename: `produkte_${slug}.csv`, csv };
  }

  private async getEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.EVENT_NOT_FOUND,
        message: 'Event nicht gefunden',
      });
    }

    return event;
  }

  private async getEventAndCheckMembership(
    eventId: string,
    userId: string,
  ): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    return event;
  }

  /**
   * Welche Steuersaetze (Prozent) darf diese Organisation fuehren?
   *
   * Die Auswahl im Formular richtet sich schon danach, aber sie ist nur
   * eine Anzeige — geprueft wird hier. Ein steuerbefreiter Verein darf
   * sonst ueber die API 19 % an ein Produkt schreiben und haette einen
   * Satz im Bestand, den er nie erheben darf. Die Agenten-Werkzeuge
   * fragen das fuer ihre Vorschau ebenfalls hier ab.
   */
  async allowedTaxRates(organizationId: string): Promise<number[]> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    return taxRatesFor(
      organization?.country ?? undefined,
      organization?.settings?.vatExempt,
    ).map((option) => option.rate);
  }

  private async assertTaxRateAllowed(
    organizationId: string,
    taxRate: number | undefined,
  ): Promise<void> {
    if (taxRate === undefined) return;
    assertTaxRateIn(await this.allowedTaxRates(organizationId), taxRate);
  }

  private async getEventAndCheckPermission(
    eventId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
  ): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.[permission]
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }

  private async getEventAndCheckAdmin(
    eventId: string,
    userId: string,
  ): Promise<Event> {
    const event = await this.getEvent(eventId);

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId: event.organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.EVENT_ACCESS_DENIED,
        message: 'Kein Zugriff auf dieses Event',
      });
    }

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return event;
  }
}
