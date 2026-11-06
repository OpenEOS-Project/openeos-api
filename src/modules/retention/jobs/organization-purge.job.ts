import { promises as fs } from 'fs';
import * as path from 'path';

import { UploadCategory } from '../../uploads/dto';
import { resolveUploadDir } from '../../uploads/upload-dir';
import { deleteFiles } from '../../assistant/menu-import/menu-import-files';
import {
  daysAfter,
  daysBefore,
  exportOfferHonoured,
} from '../retention.config';
import { organizationDeletionMail } from '../retention-mails';
import type { RetentionNoticeService } from '../retention-notice.service';
import { FISCAL_ORDER_IDS_SQL, affected, select } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/** Nach der Deaktivierung holt OpenEOS noch so lange Rest-Exporte ab. */
const TSE_COLLECT_DAYS = 35;

/** Upload-Ordner je Organisation, die beim Loeschen weg duerfen. */
export const PURGEABLE_UPLOAD_DIRS = [
  ...Object.values(UploadCategory),
  'general',
] as const;

export interface PurgeOptions {
  uploadDir: string;
  /** Ablage des Steuerarchivs; wird nie angefasst. */
  fiscalExportDir: string;
  contactEmail: string | null;
}

/**
 * Endgueltige Loeschung geloeschter bzw. geschlossener Organisationen.
 *
 * 1. Fuer jede geloeschte Organisation ohne Ankuendigung geht eine Mail an
 *    die Administratoren: Termin der Loeschung und wie ein Export
 *    angefordert werden kann.
 * 2. Faellig ist die Loeschung, wenn die Exportfrist
 *    (`RETENTION_EXPORT_PERIOD_DAYS`, 30) seit der Loeschung abgelaufen ist
 *    UND die Ankuendigung mindestens `RETENTION_NOTICE_DAYS` (30) Tage
 *    zurueckliegt. Ohne Ankuendigung keine Loeschung.
 * 3. Geloescht werden Kundendaten ohne Aufbewahrungspflicht. Erhalten
 *    bleiben das Steuerarchiv (TSE-Tabellen, Kassenabschluesse, Kassenbuch,
 *    Kassen-Zaehler), die Bestellungen, auf die es verweist (ohne
 *    Gaesteangaben), die Abrechnung des Betreibers (Veranstaltungen mit
 *    Abrechnungsfeldern, Rechnungen, Stornos) und die Organisation als
 *    gesperrte Huelle mit Name, Anschrift und Steuernummer.
 *
 * Solange die Cloud-TSE laeuft, Rest-Exporte abgeholt werden oder Vorgaenge
 * noch keinem Kassenabschluss zugeordnet sind, wird nicht geloescht.
 */
export class OrganizationPurgeJob implements RetentionJob {
  readonly category = 'organization_purge' as const;

  constructor(
    private readonly notices: RetentionNoticeService,
    private readonly options: PurgeOptions,
  ) {}

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now, config } = ctx;

    // Wiederhergestellte Organisationen: Ankuendigung verfaellt.
    const restored = await select<{ id: string }>(
      manager,
      `SELECT n.id FROM retention_notices n
         JOIN organizations o ON o.id = n.subject_id
        WHERE n.subject_type = 'organization' AND n.kind = 'organization_deletion'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL
          AND o.deleted_at IS NULL`,
    );
    for (const notice of restored) {
      await this.notices.cancel(manager, notice.id, now, 'restored');
      ctx.note('noticesCancelledRestored', 1);
    }

    // 1. Ankuendigen.
    const unannounced = await select<{
      id: string;
      name: string;
      deleted_at: Date;
      closed_for_inactivity: boolean;
    }>(
      manager,
      `SELECT o.id, o.name, o.deleted_at,
              EXISTS (SELECT 1 FROM retention_notices i
                       WHERE i.subject_type = 'organization' AND i.subject_id = o.id
                         AND i.kind = 'organization_inactivity'
                         AND i.executed_at IS NOT NULL) AS closed_for_inactivity
         FROM organizations o
        WHERE o.deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM retention_notices n
                           WHERE n.subject_type = 'organization' AND n.subject_id = o.id
                             AND n.kind = 'organization_deletion'
                             AND n.cancelled_at IS NULL)`,
    );
    for (const org of unannounced) {
      if (ctx.dryRun) {
        ctx.note('noticesDue', 1);
        continue;
      }
      const deletedAt = new Date(org.deleted_at);
      const dueAt = new Date(
        Math.max(
          daysAfter(deletedAt, config.exportPeriodDays).getTime(),
          daysAfter(now, config.noticeDays).getTime(),
        ),
      );
      const recipients = await this.notices.organizationRecipients(
        manager,
        org.id,
      );
      const result = await this.notices.send(
        manager,
        {
          subjectType: 'organization',
          subjectId: org.id,
          kind: 'organization_deletion',
          now,
          dueAt,
          activityAt: deletedAt,
        },
        recipients,
        (to) =>
          organizationDeletionMail({
            to,
            appUrl: this.notices.appUrl,
            organizationName: org.name,
            deletedAt,
            closedForInactivity: org.closed_for_inactivity,
            dueAt,
            contactEmail: this.options.contactEmail,
          }),
      );
      if (!result.recorded) ctx.note('noticesFailed', 1);
      else if (recipients.length === 0) ctx.note('noticesWithoutRecipient', 1);
      else ctx.note('noticesSent', 1);
    }

    // 2. Faellige Loeschungen.
    const due = await select<{
      id: string;
      subject_id: string;
      sent_at: Date;
      deleted_at: Date;
    }>(
      manager,
      `SELECT n.id, n.subject_id, n.sent_at, o.deleted_at
         FROM retention_notices n
         JOIN organizations o ON o.id = n.subject_id
        WHERE n.subject_type = 'organization' AND n.kind = 'organization_deletion'
          AND n.executed_at IS NULL AND n.cancelled_at IS NULL
          AND o.deleted_at IS NOT NULL AND n.due_at <= $1`,
      [now],
    );
    for (const notice of due) {
      if (
        !exportOfferHonoured(
          new Date(notice.sent_at),
          now,
          config.noticeDays,
        ) ||
        new Date(notice.deleted_at) > daysBefore(now, config.exportPeriodDays)
      ) {
        ctx.note('skippedExportPeriod', 1);
        continue;
      }
      const blocker = await this.blocker(ctx, notice.subject_id);
      if (blocker) {
        ctx.note(blocker, 1);
        continue;
      }
      await this.purge(ctx, notice.subject_id);
      await this.notices.markExecuted(manager, notice.id, now);
      ctx.removed('organizationsPurged', 1);
    }
  }

  /**
   * Grund, warum (noch) nicht geloescht werden darf, sonst `null`. Gilt
   * auch fuer die sofortige Loeschung auf Verlangen.
   */
  async blocker(
    ctx: RetentionRunContext,
    organizationId: string,
  ): Promise<string | null> {
    const [row] = await select<{
      tse_live: boolean;
      tse_collecting: boolean;
      unclosed: boolean;
    }>(
      ctx.manager,
      `SELECT
         EXISTS (SELECT 1 FROM tse_units WHERE organization_id = $1
                   AND state IN ('creating', 'active')) AS tse_live,
         EXISTS (SELECT 1 FROM tse_units WHERE organization_id = $1
                   AND state = 'deactivated' AND deactivated_at > $2) AS tse_collecting,
         EXISTS (SELECT 1 FROM tse_transactions WHERE organization_id = $1
                   AND cash_point_closing_id IS NULL) AS unclosed`,
      [organizationId, daysBefore(ctx.now, TSE_COLLECT_DAYS)],
    );
    if (row?.tse_live) return 'skippedTseActive';
    if (row?.tse_collecting) return 'skippedTseExportWindow';
    if (row?.unclosed) return 'skippedUnclosedTransactions';
    return null;
  }

  /**
   * Loescht die Kundendaten einer Organisation ($1). Reihenfolge nach den
   * Fremdschluesseln; was am Steuerarchiv haengt, bleibt.
   */
  async purge(ctx: RetentionRunContext, organizationId: string): Promise<void> {
    const { manager } = ctx;
    const org = [organizationId];
    const run = async (key: string, statement: string) =>
      ctx.removed(key, await affected(manager, statement, org));
    const events = `SELECT id FROM events WHERE organization_id = $1`;

    // Bestellungen: ohne Bezug zum Steuerarchiv weg (mit Positionen,
    // Zahlungen, Erstattungen, Verlauf), sonst nur Gaesteangaben leeren.
    await run(
      'ordersDeleted',
      `DELETE FROM orders WHERE organization_id = $1
          AND id NOT IN (SELECT order_id FROM (${FISCAL_ORDER_IDS_SQL}) f
                          WHERE order_id IS NOT NULL)`,
    );
    await run(
      'orderItemNotesCleared',
      `UPDATE order_items SET notes = NULL, kitchen_notes = NULL
        WHERE (notes IS NOT NULL OR kitchen_notes IS NOT NULL)
          AND order_id IN (SELECT id FROM orders WHERE organization_id = $1)`,
    );
    await run(
      'ordersAnonymised',
      `UPDATE orders SET customer_name = NULL, customer_phone = NULL, notes = NULL
        WHERE organization_id = $1
          AND (customer_name IS NOT NULL OR customer_phone IS NOT NULL OR notes IS NOT NULL)`,
    );
    await run(
      'pfandReturnsDeleted',
      `DELETE FROM pfand_returns WHERE organization_id = $1
          AND id NOT IN (SELECT pfand_return_id FROM tse_transactions
                          WHERE organization_id = $1 AND pfand_return_id IS NOT NULL)`,
    );

    // Gaeste, Helfer, Ablaeufe.
    await run(
      'shopCheckoutsDeleted',
      `DELETE FROM shop_checkouts WHERE organization_id = $1`,
    );
    await run(
      'orderSessionsDeleted',
      `DELETE FROM online_order_sessions WHERE organization_id = $1`,
    );
    await run(
      'printJobsDeleted',
      `DELETE FROM print_jobs WHERE organization_id = $1`,
    );
    await run(
      'shiftPlansDeleted',
      `DELETE FROM shift_plans WHERE organization_id = $1`,
    );

    // Stammdaten der Veranstaltungen (die Veranstaltung selbst bleibt als
    // Abrechnungsnachweis, ohne Beschreibung und Einstellungen).
    await run(
      'inventoryCountsDeleted',
      `DELETE FROM inventory_counts WHERE event_id IN (${events})`,
    );
    await run(
      'stockMovementsDeleted',
      `DELETE FROM stock_movements WHERE event_id IN (${events})`,
    );
    // Artikel und Kategorien, auf die verbliebene Bestellpositionen zeigen,
    // bleiben (die Spalten sind Pflicht); sie werden nur ausgeblendet.
    await run(
      'productsDeleted',
      `DELETE FROM products p WHERE p.event_id IN (${events})
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id)`,
    );
    await run(
      'productsHidden',
      `UPDATE products SET description = NULL, image_url = NULL,
              deleted_at = COALESCE(deleted_at, now())
        WHERE event_id IN (${events})`,
    );
    await run(
      'categoriesDeleted',
      `DELETE FROM categories c WHERE c.event_id IN (${events})
          AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.category_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM categories child WHERE child.parent_id = c.id)`,
    );
    await run(
      'productionStationsDeleted',
      `DELETE FROM production_stations WHERE event_id IN (${events})`,
    );
    const imports = await select<{ id: string }>(
      manager,
      `SELECT id FROM menu_imports WHERE organization_id = $1`,
      org,
    );
    await run(
      'menuImportsDeleted',
      `DELETE FROM menu_imports WHERE organization_id = $1`,
    );
    await run(
      'eventsCleared',
      `UPDATE events SET description = NULL, settings = '{}'::jsonb
        WHERE organization_id = $1
          AND (description IS NOT NULL OR settings <> '{}'::jsonb)`,
    );

    // Stammdaten und Zugaenge der Organisation.
    for (const [key, table] of [
      ['qrCodesDeleted', 'qr_codes'],
      ['diningTablesDeleted', 'dining_tables'],
      ['tableAreasDeleted', 'table_areas'],
      ['discountVouchersDeleted', 'discount_vouchers'],
      ['pfandTypesDeleted', 'pfand_types'],
      ['discoveredPrintersDeleted', 'discovered_printers'],
      ['printersDeleted', 'printers'],
      ['printTemplatesDeleted', 'print_templates'],
      ['devicesDeleted', 'devices'],
      ['workflowEventsDeleted', 'workflow_events'],
      ['workflowsDeleted', 'workflows'],
      ['apiTokensDeleted', 'api_tokens'],
      ['invitationsDeleted', 'invitations'],
      ['aiUsageDeleted', 'ai_usage'],
      ['membershipsDeleted', 'user_organizations'],
    ] as const) {
      await run(key, `DELETE FROM ${table} WHERE organization_id = $1`);
    }

    // Die Organisation bleibt als gesperrte Huelle mit den Stammdaten des
    // Steuerarchivs (Name, Anschrift, Steuernummer, Waehrung, Zeitzone,
    // DSFinV-K-Einstellungen); Kontakt-E-Mail/-Telefon, Zugangsdaten von
    // Zahlungsanbietern, Rechtstexte und Logo entfallen, die Shop-Adresse
    // (slug) wird frei.
    await run(
      'organizationsPseudonymised',
      `UPDATE organizations SET
          slug = 'purged-' || id::text,
          logo_url = NULL,
          billing_email = NULL,
          support_pin = lpad((floor(random() * 1000000))::int::text, 6, '0'),
          settings = jsonb_strip_nulls(jsonb_build_object(
            'currency', settings -> 'currency',
            'timezone', settings -> 'timezone',
            'locale', settings -> 'locale',
            'legalName', settings -> 'legalName',
            'taxId', settings -> 'taxId',
            'taxNumber', settings -> 'taxNumber',
            'vatId', settings -> 'vatId',
            'vatExempt', settings -> 'vatExempt',
            'address', settings -> 'address',
            'contact', CASE WHEN jsonb_typeof(settings -> 'contact') = 'object'
                            THEN (settings -> 'contact') - 'email' - 'phone' END,
            'dsfinvk', settings -> 'dsfinvk',
            'integrations', settings -> 'integrations'))
        WHERE id = $1`,
    );

    ctx.afterCommit(async () => {
      for (const menuImport of imports) {
        await deleteFiles(this.options.uploadDir, menuImport.id);
      }
      await removeOwnerUploads(
        this.options.uploadDir,
        this.options.fiscalExportDir,
        organizationId,
      );
    });
  }
}

/**
 * Loescht die Upload-Ordner eines Eigentuemers (Organisation oder Benutzer):
 * nur die bekannten Kategorien, nie etwas im Ablageort des Steuerarchivs.
 */
export async function removeOwnerUploads(
  uploadDir: string,
  fiscalExportDir: string,
  ownerId: string,
): Promise<void> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(ownerId)) return;
  const root = path.resolve(resolveUploadDir(uploadDir), ownerId);
  const fiscal = path.resolve(fiscalExportDir);
  for (const dir of PURGEABLE_UPLOAD_DIRS) {
    const target = path.resolve(root, dir);
    if (!target.startsWith(root + path.sep)) continue;
    if (target === fiscal || target.startsWith(fiscal + path.sep)) continue;
    if (fiscal.startsWith(target + path.sep)) continue;
    await fs.rm(target, { recursive: true, force: true });
  }
}
