import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { RetentionRun } from '../../database/entities';
import type { OrganizationPurgeJob } from './jobs/organization-purge.job';
import { organizationPurgedMail } from './retention-mails';
import { RetentionNoticeService } from './retention-notice.service';
import { affected, select } from './retention-sql';
import { RetentionService } from './retention.service';
import {
  RETENTION_JOBS,
  type RetentionJob,
  type RetentionRunContext,
} from './retention.types';

export type ErasureKind =
  | 'order'
  | 'guest_email'
  | 'shift_registration'
  | 'helper_email';

export const ERASURE_KINDS: ErasureKind[] = [
  'order',
  'guest_email',
  'shift_registration',
  'helper_email',
];

export interface PurgeRequest {
  organizationId: string;
  /** Name der Organisation zur Bestaetigung. */
  confirmName: string;
  /** Anlass, z. B. Datum und Weg des Verlangens. Ohne Inhalte. */
  reason: string;
  executedByUserId: string;
  dryRun?: boolean;
}

/** Texte fuer die Gruende, aus denen nicht (sofort) geloescht werden darf. */
const PURGE_BLOCKERS: Record<string, string> = {
  skippedTseActive:
    'Die Cloud-TSE der Organisation ist noch aktiv. Deaktiviere sie zuerst.',
  skippedTseExportWindow:
    'Die Cloud-TSE wurde vor weniger als 35 Tagen deaktiviert; ihre letzten Exporte werden noch abgeholt.',
  skippedUnclosedTransactions:
    'Es gibt Kassenvorgänge ohne Kassenabschluss. Erstelle zuerst den Kassenabschluss.',
};

export interface ErasureRequest {
  organizationId: string;
  kind: ErasureKind;
  /** Bestellung bzw. Schichtanmeldung (bei `order`, `shift_registration`). */
  id?: string;
  /** E-Mail-Adresse des Gastes bzw. Helfers (bei `*_email`). */
  email?: string;
  /** Anlass, z. B. Datum und Weg der Weisung. Ohne Inhalte. */
  reason: string;
  executedByUserId: string;
  dryRun?: boolean;
}

/** Leert die Gaesteangaben der Bestellungen, die `ids` ($1) liefert. */
async function anonymiseOrders(
  ctx: RetentionRunContext,
  orderIdsSql: string,
  params: unknown[],
): Promise<void> {
  ctx.removed(
    'orderItemNotesCleared',
    await affected(
      ctx.manager,
      `UPDATE order_items SET notes = NULL
        WHERE notes IS NOT NULL AND order_id IN (${orderIdsSql})`,
      params,
    ),
  );
  ctx.removed(
    'ordersAnonymised',
    await affected(
      ctx.manager,
      `UPDATE orders SET customer_name = NULL, customer_phone = NULL, notes = NULL
        WHERE id IN (${orderIdsSql})
          AND (customer_name IS NOT NULL OR customer_phone IS NOT NULL OR notes IS NOT NULL)`,
      params,
    ),
  );
  ctx.removed(
    'shopCheckoutsAnonymised',
    await affected(
      ctx.manager,
      `UPDATE shop_checkouts SET email = '', customer_name = NULL
        WHERE order_id IN (${orderIdsSql})
          AND (email <> '' OR customer_name IS NOT NULL)`,
      params,
    ),
  );
  ctx.removed(
    'orderSessionsAnonymised',
    await affected(
      ctx.manager,
      `UPDATE online_order_sessions
          SET customer_name = NULL, cart = '{"items": [], "updatedAt": ""}'::jsonb
        WHERE id IN (SELECT online_session_id FROM orders
                      WHERE id IN (${orderIdsSql}) AND online_session_id IS NOT NULL)
          AND (customer_name IS NOT NULL OR cart -> 'items' <> '[]'::jsonb)`,
      params,
    ),
  );
  ctx.removed(
    'printJobsDeleted',
    await affected(
      ctx.manager,
      `DELETE FROM print_jobs WHERE order_id IN (${orderIdsSql})`,
      params,
    ),
  );
}

/** Loescht Schichtanmeldungen ($1 = Organisation) samt Vorschlaegen und Links. */
async function deleteRegistrations(
  ctx: RetentionRunContext,
  registrationFilter: string,
  params: unknown[],
): Promise<void> {
  const rows = await select<{
    id: string;
    group_id: string;
    email: string | null;
    plan_id: string;
  }>(
    ctx.manager,
    `SELECT r.id, r.registration_group_id AS group_id, r.email, sj.shift_plan_id AS plan_id
       FROM shift_registrations r
       JOIN shifts s ON s.id = r.shift_id
       JOIN shift_jobs sj ON sj.id = s.shift_job_id
       JOIN shift_plans sp ON sp.id = sj.shift_plan_id
      WHERE sp.organization_id = $1 AND ${registrationFilter}`,
    params,
  );
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const groups = [...new Set(rows.map((r) => r.group_id))];
  ctx.removed(
    'registrationsDeleted',
    await affected(
      ctx.manager,
      `DELETE FROM shift_registrations WHERE id = ANY($1::uuid[])`,
      [ids],
    ),
  );
  ctx.removed(
    'changeProposalsDeleted',
    await affected(
      ctx.manager,
      `DELETE FROM shift_change_proposals
        WHERE organization_id = $1 AND registration_group_id = ANY($2::uuid[])`,
      [params[0], groups],
    ),
  );
  for (const row of rows) {
    if (!row.email) continue;
    ctx.removed(
      'helperLinksDeleted',
      await affected(
        ctx.manager,
        `DELETE FROM helper_magic_links
          WHERE shift_plan_id = $1 AND lower(email) = lower($2)`,
        [row.plan_id, row.email],
      ),
    );
  }
}

/**
 * Einzelloeschung auf Weisung des Kunden (Art. 28 Abs. 3 lit. e DSGVO):
 * ein Super-Admin loescht bzw. anonymisiert die Angaben eines bestimmten
 * Gastes oder Helfers einer Organisation sofort, unabhaengig von den
 * Fristen. Bestellungen bleiben dabei ohne Personenbezug erhalten; das
 * Steuerarchiv enthaelt keine Gaesteangaben und bleibt unberuehrt.
 *
 * Jede Einzelloeschung steht mit ausfuehrender Person und Anlass im
 * Protokoll der Loeschlaeufe (Ausloeser `instruction`).
 */
@Injectable()
export class RetentionErasureService {
  constructor(
    private readonly retention: RetentionService,
    private readonly notices: RetentionNoticeService,
    @Inject(RETENTION_JOBS) private readonly jobs: RetentionJob[],
  ) {}

  private get purgeJob(): OrganizationPurgeJob {
    const job = this.jobs.find((j) => j.category === 'organization_purge');
    if (!job) throw new Error('organization_purge job missing');
    return job as OrganizationPurgeJob;
  }

  /**
   * Sofortige endgueltige Loeschung einer Organisation auf Verlangen des
   * Kunden (AVV 10.2 Satz 3, AGB 20.5), vor Ablauf der Exportfrist. Es
   * gelten dieselben Regeln wie bei der regulaeren Loeschung: das
   * Steuerarchiv bleibt, bei aktiver Cloud-TSE, laufender Abholung der
   * Rest-Exporte oder Vorgaengen ohne Kassenabschluss wird nicht geloescht.
   * Ist die Organisation noch nicht geloescht, wird sie im selben Schritt
   * geschlossen.
   *
   * Protokoll: `retention_runs` (Ausloeser `instruction`, ausfuehrende
   * Person, Anlass); die Ankuendigung `organization_deletion` gilt als
   * ausgefuehrt. Die Administratoren bekommen eine Bestaetigung (AVV 10.5).
   */
  async purgeOrganization(request: PurgeRequest): Promise<RetentionRun> {
    const [org] = await this.retention.query<{
      id: string;
      name: string;
      deleted_at: Date | null;
      purged: boolean;
    }>(
      `SELECT o.id, o.name, o.deleted_at,
              (o.slug LIKE 'purged-%' OR EXISTS (
                 SELECT 1 FROM retention_notices n
                  WHERE n.subject_type = 'organization' AND n.subject_id = o.id
                    AND n.kind = 'organization_deletion'
                    AND n.executed_at IS NOT NULL)) AS purged
         FROM organizations o WHERE o.id = $1`,
      [request.organizationId],
    );
    if (!org) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    if (org.purged) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORGANIZATION_ALREADY_PURGED,
        message: 'Diese Organisation ist bereits endgültig gelöscht.',
      });
    }
    if (request.confirmName.trim() !== org.name.trim()) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.ORGANIZATION_PURGE_CONFIRMATION_MISMATCH,
        message:
          'Der eingegebene Name stimmt nicht mit dem Namen der Organisation überein.',
      });
    }

    const job = this.purgeJob;
    const dryRun = request.dryRun ?? false;
    // Empfaenger vor dem Loeschen der Mitgliedschaften festhalten.
    const recipients = await this.notices.organizationRecipients(
      this.retention.manager,
      org.id,
    );
    const state: { blocked: string | null } = { blocked: null };
    const run = await this.retention.runJob(
      {
        category: 'organization_purge',
        run: async (ctx) => {
          state.blocked = await job.blocker(ctx, org.id);
          if (state.blocked) {
            ctx.note(state.blocked, 1);
            return;
          }
          ctx.removed(
            'organizationsClosed',
            await affected(
              ctx.manager,
              `UPDATE organizations SET deleted_at = $2
                WHERE id = $1 AND deleted_at IS NULL`,
              [org.id, ctx.now],
            ),
          );
          await job.purge(ctx, org.id);
          await this.recordExecuted(ctx, org.id);
          ctx.removed('organizationsPurged', 1);
        },
      },
      {
        trigger: 'instruction',
        dryRun,
        organizationId: org.id,
        executedByUserId: request.executedByUserId,
        reason: request.reason,
      },
    );
    if (state.blocked) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORGANIZATION_PURGE_BLOCKED,
        message:
          PURGE_BLOCKERS[state.blocked] ??
          'Die Organisation kann noch nicht gelöscht werden.',
        params: { blocker: state.blocked, runId: run.id },
      });
    }
    if (run.status === 'succeeded' && !dryRun) {
      await this.notices.deliver(
        recipients,
        (to) =>
          organizationPurgedMail({
            to,
            appUrl: this.notices.appUrl,
            organizationName: org.name,
            purgedAt: run.finishedAt ?? new Date(),
          }),
        `Purge confirmation ${org.id}`,
      );
    }
    return run;
  }

  /** Offene Ankuendigungen der Organisation abschliessen bzw. nachtragen. */
  private async recordExecuted(
    ctx: RetentionRunContext,
    organizationId: string,
  ): Promise<void> {
    const { manager, now } = ctx;
    await manager.query(
      `UPDATE retention_notices SET cancelled_at = $2, cancel_reason = 'deleted'
        WHERE subject_type = 'organization' AND subject_id = $1
          AND kind = 'organization_inactivity'
          AND executed_at IS NULL AND cancelled_at IS NULL`,
      [organizationId, now],
    );
    const updated = await affected(
      manager,
      `UPDATE retention_notices SET executed_at = $2
        WHERE subject_type = 'organization' AND subject_id = $1
          AND kind = 'organization_deletion'
          AND executed_at IS NULL AND cancelled_at IS NULL`,
      [organizationId, now],
    );
    if (updated === 0) {
      // Ohne vorherige Ankuendigung: als ausgefuehrt nachtragen, damit der
      // naechtliche Lauf die Huelle nicht noch einmal ankuendigt.
      await manager.query(
        `INSERT INTO retention_notices
           (subject_type, subject_id, kind, sent_at, recipient_count, due_at, executed_at)
         VALUES ('organization', $1, 'organization_deletion', $2, 0, $2, $2)`,
        [organizationId, now],
      );
    }
  }

  async erase(request: ErasureRequest): Promise<RetentionRun> {
    const job = await this.buildJob(request);
    return this.retention.runJob(job, {
      trigger: 'instruction',
      dryRun: request.dryRun ?? false,
      organizationId: request.organizationId,
      executedByUserId: request.executedByUserId,
      reason: request.reason,
    });
  }

  private async buildJob(request: ErasureRequest): Promise<RetentionJob> {
    const org = request.organizationId;
    await this.assertExists(`SELECT 1 FROM organizations WHERE id = $1`, [org]);
    switch (request.kind) {
      case 'order': {
        await this.assertExists(
          `SELECT 1 FROM orders WHERE id = $1 AND organization_id = $2`,
          [request.id, org],
        );
        return {
          category: 'guest_data',
          run: (ctx) =>
            anonymiseOrders(
              ctx,
              `SELECT id FROM orders WHERE id = $1 AND organization_id = $2`,
              [request.id, org],
            ),
        };
      }
      case 'guest_email': {
        const email = request.email!.trim();
        // Shop-Checkouts mit der Adresse, ihre Bestellungen und Bestellungen,
        // in deren Anmerkung die Adresse steht (Shop-Bestellungen).
        const orders = `SELECT order_id FROM shop_checkouts
                         WHERE organization_id = $1 AND lower(email) = lower($2)
                           AND order_id IS NOT NULL
                        UNION
                        SELECT id FROM orders
                         WHERE organization_id = $1
                           AND strpos(lower(notes), lower($2)) > 0`;
        return {
          category: 'guest_data',
          run: async (ctx) => {
            await anonymiseOrders(ctx, orders, [org, email]);
            ctx.removed(
              'shopCheckoutsAnonymised',
              await affected(
                ctx.manager,
                `UPDATE shop_checkouts SET email = '', customer_name = NULL
                  WHERE organization_id = $1 AND lower(email) = lower($2)`,
                [org, email],
              ),
            );
          },
        };
      }
      case 'shift_registration': {
        await this.assertExists(
          `SELECT 1 FROM shift_registrations r
             JOIN shifts s ON s.id = r.shift_id
             JOIN shift_jobs sj ON sj.id = s.shift_job_id
             JOIN shift_plans sp ON sp.id = sj.shift_plan_id
            WHERE r.id = $1 AND sp.organization_id = $2`,
          [request.id, org],
        );
        // Die ganze Anmeldung (alle Schichten derselben Eingabe).
        return {
          category: 'helper_data',
          run: (ctx) =>
            deleteRegistrations(
              ctx,
              `r.registration_group_id = (SELECT registration_group_id
                                            FROM shift_registrations WHERE id = $2)`,
              [org, request.id],
            ),
        };
      }
      case 'helper_email': {
        const email = request.email!.trim();
        return {
          category: 'helper_data',
          run: (ctx) =>
            deleteRegistrations(ctx, `lower(r.email) = lower($2)`, [
              org,
              email,
            ]),
        };
      }
    }
  }

  private async assertExists(sql: string, params: unknown[]): Promise<void> {
    const rows = await this.retention.query(sql, params);
    if (rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.RETENTION_RECORD_NOT_FOUND,
        message: 'Kein passender Datensatz in dieser Organisation gefunden.',
      });
    }
  }
}
