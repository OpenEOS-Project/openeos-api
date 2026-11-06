import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import {
  Category,
  MenuImport,
  MenuSuggestion,
  Organization,
  Product,
} from '../../../database/entities';
import { CronLockService } from '../../../common/redis/cron-lock.service';
import { GatewayService } from '../../gateway/gateway.service';
import { AI_PROVIDER } from '../../ai/ai-provider.interface';
import type { AiInputFile, AiProvider } from '../../ai/ai-provider.interface';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AiInputFilesService } from '../../ai/ai-input-files.service';
import { readAiConfig } from '../../ai/ai-provider.factory';
import { wrapUntrusted } from '../../ai/providers/structured-output.util';
import { IconSuggestionService } from '../icon-suggestion.service';
import { describeMenuImportFailure } from './menu-import-errors';
import { deleteFiles, readFiles } from './menu-import-files';
import {
  MENU_EXTRACTION_SCHEMA,
  MENU_EXTRACTION_SCHEMA_NAME,
  MENU_EXTRACTION_SYSTEM_PROMPT,
  RawMenuExtraction,
  mergeExtractions,
  validateExtraction,
} from './menu-extraction.schema';
import { mapExtraction } from './menu-suggestion.mapper';

/** Nach so langer Zeit gilt ein `processing` als abgebrochen. */
const STUCK_AFTER_MS = 15 * 60 * 1000;
/** `queued`, das so lange keiner angefasst hat, holt der Cron nach. */
const RETRY_QUEUED_AFTER_MS = 60 * 1000;
/** Dateien leben hoechstens so lange. */
const FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Der Vorschlag (JSON) bleibt hoechstens so lange. */
const IMPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Wertet Speisekarten-Importe im Hintergrund aus.
 *
 * Kein eigener Job-Dienst: `kick()` startet die Verarbeitung auf der
 * Instanz, die den Upload entgegengenommen hat (setImmediate). Den
 * Eintrag sperrt ein bedingtes UPDATE (`queued` → `processing`), damit
 * zwei Instanzen nie dieselbe Karte auswerten. Was liegen bleibt (die
 * Instanz starb, der Prozess wurde neu gestartet), holt der
 * Minuten-Cron nach — mit Redis-Sperre, einer je Minute.
 */
@Injectable()
export class MenuImportWorkerService {
  private readonly logger = new Logger(MenuImportWorkerService.name);
  private readonly uploadDir: string;
  private readonly maxPages: number;

  constructor(
    @InjectRepository(MenuImport)
    private readonly importRepository: Repository<MenuImport>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly quota: AiQuotaService,
    private readonly iconSuggestions: IconSuggestionService,
    private readonly gatewayService: GatewayService,
    private readonly cronLock: CronLockService,
    configService: ConfigService,
    private readonly inputFiles: AiInputFilesService,
  ) {
    this.uploadDir = configService.get<string>('UPLOAD_DIR') || './uploads';
    this.maxPages = readAiConfig(configService).menuPagesPerImport;
  }

  /** Verarbeitung anstossen, ohne die Antwort auf den Upload aufzuhalten. */
  kick(importId: string): void {
    setImmediate(() => {
      this.process(importId).catch((error: unknown) => {
        this.logger.error(
          `Import ${importId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  /** Wertet einen Import aus, wenn er noch `queued` ist. */
  async process(importId: string): Promise<boolean> {
    const claimed = await this.importRepository
      .createQueryBuilder()
      .update(MenuImport)
      .set({ status: 'processing' })
      .where('id = :id AND status = :status', {
        id: importId,
        status: 'queued',
      })
      .execute();
    if (!claimed.affected) return false;

    const menuImport = await this.importRepository.findOne({
      where: { id: importId },
    });
    if (!menuImport) return false;
    this.notify(menuImport, 'processing');

    const started = Date.now();
    try {
      const suggestion = await this.extract(menuImport);
      await this.importRepository.update(
        { id: menuImport.id },
        {
          status: 'done',
          suggestion,
          error: null,
          errorDetail: null,
          finishedAt: new Date(),
        },
      );
      this.logger.log(
        `Import ${menuImport.id}: ${suggestion.products.length} Produkte in ${suggestion.categories.length} Kategorien (${Date.now() - started} ms)`,
      );
      this.notify(menuImport, 'done');
    } catch (error) {
      // Nutzer sehen nur den kurzen Hinweis; die Rohmeldung bleibt hier
      // im Log und in `error_detail`.
      const failure = describeMenuImportFailure(error);
      this.logger.warn(
        `Import ${menuImport.id} fehlgeschlagen: ${failure.detail}`,
      );
      if (menuImport.usageId) {
        await this.quota.settle(menuImport.usageId, { status: 'error' });
      }
      await this.importRepository.update(
        { id: menuImport.id },
        {
          status: 'failed',
          error: failure.message,
          errorDetail: failure.detail,
          finishedAt: new Date(),
        },
      );
      this.notify(menuImport, 'failed');
    }
    return true;
  }

  private async extract(menuImport: MenuImport): Promise<MenuSuggestion> {
    const uploaded: AiInputFile[] =
      menuImport.files.length > 0
        ? (await readFiles(this.uploadDir, menuImport.files)).map((file) => ({
            mediaType: file.mediaType,
            data: file.buffer,
          }))
        : [];
    // Fotos verkleinern, PDF ggf. in Seitenbilder; dann nach
    // AI_MAX_IMAGES_PER_REQUEST in Aufrufe teilen (IONOS: hoechstens 4).
    const files = await this.inputFiles.prepare(uploaded, {
      maxPages: this.maxPages,
    });
    const batches = files.length > 0 ? this.inputFiles.batches(files) : [[]];

    const parts: RawMenuExtraction[] = [];
    let lastValue: unknown = null;
    const usage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    let model = '';
    let firstPage = 1;
    for (const [index, batch] of batches.entries()) {
      const result = await this.provider.extractStructured<unknown>({
        purpose: 'extract',
        system: MENU_EXTRACTION_SYSTEM_PROMPT,
        text: this.promptFor(menuImport, {
          batch,
          batchCount: batches.length,
          firstPage,
          totalPages: files.length,
          previous: parts,
        }),
        files: batch,
        schemaName: MENU_EXTRACTION_SCHEMA_NAME,
        schema: MENU_EXTRACTION_SCHEMA,
      });
      usage.inputTokens += result.inputTokens;
      usage.outputTokens += result.outputTokens;
      usage.durationMs += result.durationMs;
      model = result.model;
      lastValue = result.value;
      firstPage += batch.length;
      // Teilergebnis gleich pruefen: die naechsten Seiten bekommen dessen
      // Kategorien und Hinweise als Kontext mit.
      if (index < batches.length - 1) {
        parts.push(validateExtraction(result.value));
      }
    }

    if (menuImport.usageId) {
      await this.quota.settle(menuImport.usageId, {
        status: 'ok',
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: usage.durationMs,
      });
    }
    await this.importRepository.update(
      { id: menuImport.id },
      {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      },
    );
    if (batches.length > 1) {
      this.logger.log(
        `Import ${menuImport.id}: ${files.length} Seiten in ${batches.length} Aufrufen (AI_MAX_IMAGES_PER_REQUEST)`,
      );
    }

    const extraction = mergeExtractions([
      ...parts,
      validateExtraction(lastValue),
    ]);
    const [existingCategories, existingProducts, organization] =
      await Promise.all([
        this.categoryRepository.find({
          where: { eventId: menuImport.eventId },
          select: ['id', 'name'],
        }),
        this.productRepository.find({
          where: { eventId: menuImport.eventId },
          select: ['id', 'name'],
        }),
        this.organizationRepository.findOne({
          where: { id: menuImport.organizationId },
        }),
      ]);

    const suggestion = mapExtraction({
      extraction,
      existingCategories,
      existingProducts,
      vatExempt: organization?.settings?.vatExempt !== false,
    });
    // Kein Produkt erkannt ist kein Fehler (der Aufruf ist abgerechnet):
    // der Vorschlag bleibt leer und traegt den Hinweis aus validateExtraction.
    if (suggestion.products.length === 0) return suggestion;
    return this.attachIcons(menuImport, suggestion);
  }

  /**
   * Nutzertext je Aufruf. Bei mehreren Aufrufen erfaehrt das Modell, welche
   * Seiten es sieht, und bekommt Kategorien und Hinweise der vorherigen
   * Seiten mit — als Daten markiert, denn sie stammen aus der Karte.
   */
  private promptFor(
    menuImport: MenuImport,
    context: {
      batch: AiInputFile[];
      batchCount: number;
      firstPage: number;
      totalPages: number;
      previous: RawMenuExtraction[];
    },
  ): string {
    const parts: string[] = [];
    if (menuImport.source === 'text') {
      parts.push(
        'Hier ist der Text der Speisekarte:',
        wrapUntrusted('menu-text', menuImport.inputText ?? ''),
      );
    } else if (context.batchCount === 1) {
      parts.push(
        context.batch.length === 1
          ? 'Die Speisekarte ist die angehängte Datei.'
          : `Die Speisekarte sind die ${context.batch.length} angehängten Seiten in dieser Reihenfolge.`,
      );
    } else {
      const last = context.firstPage + context.batch.length - 1;
      parts.push(
        `Die Speisekarte hat ${context.totalPages} Seiten und wird in ${context.batchCount} Teilen gelesen. ` +
          (context.batch.length === 1
            ? `Angehängt ist Seite ${context.firstPage}.`
            : `Angehängt sind die Seiten ${context.firstPage} bis ${last} in dieser Reihenfolge.`) +
          ' Gib nur zurück, was auf diesen Seiten steht.',
      );
      if (context.previous.length > 0) {
        const categories = [
          ...new Set(
            context.previous.flatMap((part) =>
              part.categories.map((category) => category.name),
            ),
          ),
        ];
        const warnings = [
          ...new Set(context.previous.flatMap((part) => part.warnings)),
        ];
        parts.push(
          'Kategorien und Hinweise der vorherigen Seiten (nur als Kontext): Setzt sich eine Kategorie hier ohne eigene Überschrift fort, verwende denselben Namen. Ein allgemeiner Hinweis von dort (etwa ein Pfand für alle Getränke) gilt auch für passende Produkte auf diesen Seiten.',
          wrapUntrusted(
            'previous-pages',
            JSON.stringify({ categories, warnings }),
          ),
        );
      }
    }
    parts.push(
      'Gib alle Kategorien und Produkte als strukturierte Daten zurück.',
    );
    return parts.join('\n\n');
  }

  private async attachIcons(
    menuImport: MenuImport,
    suggestion: MenuSuggestion,
  ): Promise<MenuSuggestion> {
    try {
      const names = suggestion.products.map((product) => product.name);
      const results = await this.iconSuggestions.suggest(
        menuImport.organizationId,
        menuImport.userId,
        names,
      );
      const byName = new Map(
        results.map((result) => [result.name, result.suggestions]),
      );
      return {
        ...suggestion,
        products: suggestion.products.map((product) => {
          const icons = byName.get(product.name) ?? [];
          return icons.length > 0
            ? { ...product, iconSuggestions: icons }
            : product;
        }),
      };
    } catch (error) {
      // Icons sind Beigabe — ohne sie ist der Import trotzdem brauchbar.
      this.logger.warn(
        `Import ${menuImport.id}: Icon-Vorschläge übersprungen (${(error as Error).message})`,
      );
      return suggestion;
    }
  }

  private notify(menuImport: MenuImport, status: MenuImport['status']): void {
    this.gatewayService.notifyMenuImportUpdated(menuImport.organizationId, {
      id: menuImport.id,
      eventId: menuImport.eventId,
      status,
    });
  }

  /** Liegengebliebene Importe nachholen, haengende als fehlgeschlagen markieren. */
  @Cron(CronExpression.EVERY_MINUTE)
  async recover(): Promise<void> {
    await this.cronLock.runExclusive('menu-import-recover', () =>
      this.recoverNow(),
    );
  }

  async recoverNow(now = new Date()): Promise<void> {
    const stuck = await this.importRepository.find({
      where: {
        status: 'processing',
        updatedAt: LessThan(new Date(now.getTime() - STUCK_AFTER_MS)),
      },
    });
    for (const menuImport of stuck) {
      this.logger.warn(
        `Import ${menuImport.id}: Verarbeitung abgebrochen (hängt seit >15 min)`,
      );
      if (menuImport.usageId) {
        await this.quota.settle(menuImport.usageId, { status: 'error' });
      }
      await this.importRepository.update(
        { id: menuImport.id },
        {
          status: 'failed',
          error:
            'Die Auswertung wurde abgebrochen – bitte versuch es noch einmal.',
          errorDetail:
            'processing seit mehr als 15 Minuten, von recover() abgebrochen',
          finishedAt: now,
        },
      );
      this.notify(menuImport, 'failed');
    }

    const waiting = await this.importRepository.find({
      where: {
        status: 'queued',
        createdAt: LessThan(new Date(now.getTime() - RETRY_QUEUED_AFTER_MS)),
      },
      order: { createdAt: 'ASC' },
      take: 10,
    });
    for (const menuImport of waiting) {
      await this.process(menuImport.id);
    }
  }

  /** Dateien nach 24 h, Vorschlaege nach 30 Tagen loeschen. */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(): Promise<void> {
    await this.cronLock.runExclusive('menu-import-cleanup', async () => {
      await this.cleanupNow();
    });
  }

  async cleanupNow(
    now = new Date(),
  ): Promise<{ filesDeleted: number; importsDeleted: number }> {
    const expired = await this.importRepository.find({
      where: {
        filesDeletedAt: IsNull(),
        createdAt: LessThan(new Date(now.getTime() - FILE_RETENTION_MS)),
      },
      select: ['id'],
      take: 200,
    });
    for (const menuImport of expired) {
      await deleteFiles(this.uploadDir, menuImport.id);
      await this.importRepository.update(
        { id: menuImport.id },
        { filesDeletedAt: now },
      );
    }

    const old = await this.importRepository.find({
      where: {
        createdAt: LessThan(new Date(now.getTime() - IMPORT_RETENTION_MS)),
      },
      select: ['id'],
      take: 200,
    });
    for (const menuImport of old) {
      await deleteFiles(this.uploadDir, menuImport.id);
      await this.importRepository.delete({ id: menuImport.id });
    }

    if (expired.length > 0 || old.length > 0) {
      this.logger.log(
        `Speisekarten-Importe aufgeräumt: ${expired.length} Dateiordner, ${old.length} alte Importe`,
      );
    }
    return { filesDeleted: expired.length, importsDeleted: old.length };
  }
}
