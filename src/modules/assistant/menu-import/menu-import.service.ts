import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Category,
  Event,
  MenuImport,
  MenuImportSource,
  PfandType,
  Product,
  ProductOptions,
  User,
  UserOrganization,
} from '../../../database/entities';
import { AdminAction } from '../../../database/entities/admin-audit-log.entity';
import {
  ErrorCodes,
  ErrorMessages,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import { taxRatesFor } from '../../../common/constants/tax-rates';
import { GatewayService } from '../../gateway/gateway.service';
import { AI_PROVIDER } from '../../ai/ai-provider.interface';
import type { AiProvider } from '../../ai/ai-provider.interface';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { readAiConfig } from '../../ai/ai-provider.factory';
import { AssistantService, AuditClient } from '../assistant.service';
import { loadEventForProducts } from './event-access';
import {
  MenuFileMediaType,
  deleteFiles,
  sniffMediaType,
  storeFiles,
} from './menu-import-files';
import { MenuImportWorkerService } from './menu-import-worker.service';
import { ApplyMenuImportDto, ApplyMenuProductDto } from './dto';

export interface UploadedMenuFile {
  buffer: Buffer;
  originalname?: string;
  size?: number;
}

export interface MenuImportView {
  id: string;
  status: MenuImport['status'];
  source: MenuImportSource;
  error?: string;
  createdAt: Date;
  finishedAt?: Date;
  appliedAt?: Date;
  suggestion?: MenuImport['suggestion'];
  usage?: MenuImport['usage'];
}

export interface ApplyResult {
  createdCategories: number;
  createdProducts: number;
  updatedProducts: number;
}

const MAX_TEXT_LENGTH = 20000;
const LIST_LIMIT = 20;

/**
 * Speisekarten-Import (ki-plan.md 6.3): anlegen, abfragen, anwenden,
 * verwerfen. Die Auswertung selbst macht MenuImportWorkerService im
 * Hintergrund.
 */
@Injectable()
export class MenuImportService {
  private readonly logger = new Logger(MenuImportService.name);
  private readonly uploadDir: string;
  private readonly maxUploadBytes: number;
  private readonly maxPages: number;

  constructor(
    @InjectRepository(MenuImport)
    private readonly importRepository: Repository<MenuImport>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepository: Repository<UserOrganization>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(PfandType)
    private readonly pfandTypeRepository: Repository<PfandType>,
    private readonly dataSource: DataSource,
    private readonly assistantService: AssistantService,
    private readonly quota: AiQuotaService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly worker: MenuImportWorkerService,
    private readonly gatewayService: GatewayService,
    configService: ConfigService,
  ) {
    const ai = readAiConfig(configService);
    this.uploadDir = configService.get<string>('UPLOAD_DIR') || './uploads';
    this.maxUploadBytes = ai.maxUploadMb * 1024 * 1024;
    this.maxPages = ai.menuPagesPerImport;
  }

  async create(
    organizationId: string,
    eventId: string,
    user: User,
    input: { files: UploadedMenuFile[]; text?: string },
  ): Promise<{ id: string; status: 'queued' }> {
    const event = await loadEventForProducts(
      this.eventRepository,
      this.membershipRepository,
      organizationId,
      eventId,
      user.id,
      true,
    );
    await this.assistantService.assertUsable(organizationId);

    const text = input.text?.trim() ?? '';
    const prepared = this.prepareInput(input.files, text);

    const usage = await this.quota.reserve(
      organizationId,
      user.id,
      'menu_import',
    );

    const menuImport = await this.importRepository.save(
      this.importRepository.create({
        organizationId,
        eventId: event.id,
        userId: user.id,
        status: 'queued',
        source: prepared.source,
        files: [],
        inputText: prepared.source === 'text' ? text : null,
        usageId: usage.id,
      }),
    );

    if (prepared.files.length > 0) {
      try {
        const stored = await storeFiles(
          this.uploadDir,
          menuImport.id,
          prepared.files,
        );
        menuImport.files = stored.map((file) => file.relativePath);
        await this.importRepository.update(
          { id: menuImport.id },
          { files: menuImport.files },
        );
      } catch (error) {
        await this.quota.settle(usage.id, { status: 'error' });
        await this.importRepository.delete({ id: menuImport.id });
        await deleteFiles(this.uploadDir, menuImport.id);
        throw error;
      }
    }

    this.logger.log(
      `Speisekarten-Import ${menuImport.id} angelegt (${prepared.source}, ${prepared.files.length} Datei(en)) für Event ${event.id}`,
    );
    this.gatewayService.notifyMenuImportUpdated(organizationId, {
      id: menuImport.id,
      eventId: event.id,
      status: 'queued',
    });
    this.worker.kick(menuImport.id);
    return { id: menuImport.id, status: 'queued' };
  }

  async findOne(
    organizationId: string,
    eventId: string,
    importId: string,
    user: User,
  ): Promise<MenuImportView> {
    const menuImport = await this.load(
      organizationId,
      eventId,
      importId,
      user,
      false,
    );
    return this.view(menuImport);
  }

  async list(
    organizationId: string,
    eventId: string,
    user: User,
  ): Promise<MenuImportView[]> {
    await loadEventForProducts(
      this.eventRepository,
      this.membershipRepository,
      organizationId,
      eventId,
      user.id,
      false,
    );
    const imports = await this.importRepository.find({
      where: { organizationId, eventId },
      order: { createdAt: 'DESC' },
      take: LIST_LIMIT,
    });
    return imports.map((menuImport) => this.view(menuImport, false));
  }

  async remove(
    organizationId: string,
    eventId: string,
    importId: string,
    user: User,
  ): Promise<void> {
    const menuImport = await this.load(
      organizationId,
      eventId,
      importId,
      user,
      true,
    );
    await this.importRepository.delete({ id: menuImport.id });
    await deleteFiles(this.uploadDir, menuImport.id);
    this.logger.log(`Speisekarten-Import ${menuImport.id} verworfen`);
  }

  /**
   * Legt die bestaetigten Kategorien und Produkte an (eine Transaktion).
   * Varianten werden `options.groups[0]` (Typ `single`), `sortOrder`
   * laeuft hinter dem Bestand weiter.
   */
  async apply(
    organizationId: string,
    eventId: string,
    importId: string,
    dto: ApplyMenuImportDto,
    user: User,
    client: AuditClient = {},
  ): Promise<ApplyResult> {
    const menuImport = await this.load(
      organizationId,
      eventId,
      importId,
      user,
      true,
    );
    if (menuImport.status !== 'done') {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.MENU_IMPORT_NOT_READY,
        message:
          menuImport.status === 'applied'
            ? 'Dieser Import wurde schon übernommen'
            : 'Dieser Import ist noch nicht fertig ausgewertet',
        params: { status: menuImport.status },
      });
    }
    const organization =
      await this.assistantService.assertUsable(organizationId);
    const allowedRates = taxRatesFor(
      organization.settings?.address?.country,
      organization.settings?.vatExempt,
    ).map((option) => option.rate);

    const result = await this.dataSource.transaction(async (manager) => {
      const categoryIds = await this.applyCategories(manager, eventId, dto);
      const counts: ApplyResult = {
        createdCategories: categoryIds.created,
        createdProducts: 0,
        updatedProducts: 0,
      };

      const pfandTypeIds = new Set(
        (
          await manager.find(PfandType, {
            where: { organizationId },
            select: ['id'],
          })
        ).map((pfandType) => pfandType.id),
      );

      let sortOrder =
        ((
          await manager
            .createQueryBuilder(Product, 'product')
            .select('MAX(product.sortOrder)', 'max')
            .where('product.eventId = :eventId', { eventId })
            .getRawOne<{ max: number | null }>()
        )?.max ?? 0) + 1;

      for (const product of dto.products) {
        if (product.action === 'skip') continue;
        const categoryId = categoryIds.byKey.get(product.categoryKey);
        if (!categoryId) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.MENU_IMPORT_CATEGORY_KEY_UNKNOWN,
            message: `Produkt „${product.name}“ verweist auf eine unbekannte Kategorie`,
            params: { key: product.key, categoryKey: product.categoryKey },
          });
        }
        if (!allowedRates.includes(Number(product.taxRate))) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.TAX_RATE_NOT_ALLOWED,
            message: `Steuersatz ${product.taxRate} % ist für diese Organisation nicht zulässig`,
            params: { rate: product.taxRate },
          });
        }
        if (product.pfandTypeId && !pfandTypeIds.has(product.pfandTypeId)) {
          throw new NotFoundException({
            code: ErrorCodes.NOT_FOUND,
            reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND,
            message: 'Pfand-Typ nicht gefunden',
          });
        }

        const values = {
          categoryId,
          name: product.name.trim(),
          description: product.description?.trim() || null,
          price: Math.round(product.price * 100) / 100,
          taxRate: product.taxRate,
          icon: product.icon ?? null,
          pfandTypeId: product.pfandTypeId ?? null,
          options: toOptions(product),
        };

        if (product.action === 'update') {
          const existing = product.existingProductId
            ? await manager.findOne(Product, {
                where: { id: product.existingProductId, eventId },
              })
            : null;
          if (!existing) {
            throw new NotFoundException({
              code: ErrorCodes.NOT_FOUND,
              reason: ErrorReasons.PRODUCT_NOT_FOUND,
              message: `Produkt „${product.name}“ wurde nicht gefunden`,
              params: { key: product.key },
            });
          }
          await manager.update(
            Product,
            { id: existing.id },
            {
              ...values,
              // Ein leeres Icon im Vorschlag loescht keins am Bestand.
              icon: values.icon ?? existing.icon,
            },
          );
          counts.updatedProducts += 1;
        } else {
          await manager.save(
            manager.create(Product, {
              eventId,
              ...values,
              sortOrder: sortOrder++,
            }),
          );
          counts.createdProducts += 1;
        }
      }

      await manager.update(
        MenuImport,
        { id: menuImport.id },
        { status: 'applied', appliedAt: new Date() },
      );
      return counts;
    });

    await deleteFiles(this.uploadDir, menuImport.id);
    await this.importRepository.update(
      { id: menuImport.id },
      { filesDeletedAt: new Date() },
    );
    await this.assistantService.recordAudit(
      AdminAction.MENU_IMPORT_APPLIED,
      organizationId,
      user,
      client,
      { eventId, importId: menuImport.id, ...result },
      { type: 'menu_import', id: menuImport.id },
    );
    this.gatewayService.notifyMenuRefresh(
      organizationId,
      eventId,
      'menu_import',
    );
    this.gatewayService.notifyMenuImportUpdated(organizationId, {
      id: menuImport.id,
      eventId,
      status: 'applied',
    });
    this.logger.log(
      `Speisekarten-Import ${menuImport.id} übernommen: ${result.createdCategories} Kategorien, ${result.createdProducts} neue und ${result.updatedProducts} aktualisierte Produkte`,
    );
    return result;
  }

  private async applyCategories(
    manager: EntityManager,
    eventId: string,
    dto: ApplyMenuImportDto,
  ): Promise<{ byKey: Map<string, string>; created: number }> {
    const byKey = new Map<string, string>();
    let created = 0;
    const existingIds = dto.categories
      .map((category) => category.existingCategoryId)
      .filter((id): id is string => !!id);
    const existing = existingIds.length
      ? await manager.find(Category, {
          where: { id: In(existingIds), eventId },
          select: ['id'],
        })
      : [];
    const existingSet = new Set(existing.map((category) => category.id));

    let sortOrder =
      ((
        await manager
          .createQueryBuilder(Category, 'category')
          .select('MAX(category.sortOrder)', 'max')
          .where('category.eventId = :eventId', { eventId })
          .getRawOne<{ max: number | null }>()
      )?.max ?? 0) + 1;

    for (const category of dto.categories) {
      if (category.existingCategoryId) {
        if (!existingSet.has(category.existingCategoryId)) {
          throw new NotFoundException({
            code: ErrorCodes.NOT_FOUND,
            reason: ErrorReasons.CATEGORY_NOT_FOUND,
            message: `Kategorie „${category.name}“ wurde nicht gefunden`,
            params: { key: category.key },
          });
        }
        byKey.set(category.key, category.existingCategoryId);
        continue;
      }
      const saved = await manager.save(
        manager.create(Category, {
          eventId,
          name: category.name.trim(),
          sortOrder: sortOrder++,
        }),
      );
      byKey.set(category.key, saved.id);
      created += 1;
    }
    return { byKey, created };
  }

  private prepareInput(
    files: UploadedMenuFile[],
    text: string,
  ): {
    source: MenuImportSource;
    files: { buffer: Buffer; mediaType: MenuFileMediaType }[];
  } {
    const invalid = (
      message: string,
      params?: Record<string, string | number>,
      reason?: string,
    ) =>
      new BadRequestException({
        code: ErrorCodes.MENU_IMPORT_INVALID_FILES,
        ...(reason ? { reason } : {}),
        message,
        ...(params ? { params } : {}),
      });

    if (files.length === 0) {
      if (!text) {
        throw invalid(ErrorMessages[ErrorCodes.MENU_IMPORT_INVALID_FILES]);
      }
      if (text.length > MAX_TEXT_LENGTH) {
        throw invalid(
          `Der Text ist zu lang — bitte höchstens ${MAX_TEXT_LENGTH} Zeichen`,
          { max: MAX_TEXT_LENGTH },
        );
      }
      return { source: 'text', files: [] };
    }

    if (files.length > this.maxPages) {
      throw invalid(`Bitte höchstens ${this.maxPages} Bilder je Import`, {
        max: this.maxPages,
      });
    }

    const prepared = files.map((file) => {
      if (file.buffer.length > this.maxUploadBytes) {
        throw invalid(
          `Eine Datei ist zu groß — bitte höchstens ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB`,
          { maxMb: Math.round(this.maxUploadBytes / 1024 / 1024) },
        );
      }
      const mediaType = sniffMediaType(file.buffer);
      if (!mediaType) {
        throw invalid(ErrorMessages[ErrorCodes.MENU_IMPORT_INVALID_FILES]);
      }
      return { buffer: file.buffer, mediaType };
    });

    const pdfs = prepared.filter(
      (file) => file.mediaType === 'application/pdf',
    );
    if (pdfs.length > 0) {
      if (prepared.length > 1) {
        throw invalid('Eine PDF-Datei kann nur allein hochgeladen werden');
      }
      if (!this.provider.supportsPdf()) {
        // Die Web-App blendet PDF anhand von `pdfSupported` im Status vorher
        // aus; der Reason faengt ab, was trotzdem ankommt.
        throw invalid(
          'PDF wird vom eingerichteten Anbieter nicht unterstützt — bitte lade Fotos der Seiten hoch',
          undefined,
          ErrorReasons.MENU_IMPORT_PDF_UNSUPPORTED,
        );
      }
      return { source: 'pdf', files: prepared };
    }
    return { source: 'images', files: prepared };
  }

  private async load(
    organizationId: string,
    eventId: string,
    importId: string,
    user: User,
    requireWrite: boolean,
  ): Promise<MenuImport> {
    await loadEventForProducts(
      this.eventRepository,
      this.membershipRepository,
      organizationId,
      eventId,
      user.id,
      requireWrite,
    );
    const menuImport = await this.importRepository.findOne({
      where: { id: importId, organizationId, eventId },
    });
    if (!menuImport) {
      throw new NotFoundException({
        code: ErrorCodes.MENU_IMPORT_NOT_FOUND,
        message: ErrorMessages[ErrorCodes.MENU_IMPORT_NOT_FOUND],
      });
    }
    return menuImport;
  }

  private view(menuImport: MenuImport, withSuggestion = true): MenuImportView {
    return {
      id: menuImport.id,
      status: menuImport.status,
      source: menuImport.source,
      ...(menuImport.error ? { error: menuImport.error } : {}),
      createdAt: menuImport.createdAt,
      ...(menuImport.finishedAt ? { finishedAt: menuImport.finishedAt } : {}),
      ...(menuImport.appliedAt ? { appliedAt: menuImport.appliedAt } : {}),
      ...(withSuggestion && menuImport.suggestion
        ? { suggestion: menuImport.suggestion }
        : {}),
      ...(menuImport.usage ? { usage: menuImport.usage } : {}),
    };
  }
}

/** Varianten → `options.groups[0]` (eine Auswahl, Pflicht, erste Variante Standard). */
export function toOptions(
  product: Pick<ApplyMenuProductDto, 'variants'>,
): ProductOptions {
  if (!product.variants || product.variants.length === 0) {
    return { groups: [] };
  }
  return {
    groups: [
      {
        name: 'Größe',
        type: 'single',
        required: true,
        options: product.variants.map((variant, index) => ({
          name: variant.name.trim(),
          priceModifier: Math.round(variant.priceModifier * 100) / 100,
          ...(index === 0 ? { default: true } : {}),
        })),
      },
    ],
  };
}
