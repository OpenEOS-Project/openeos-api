import { Injectable, NotFoundException } from '@nestjs/common';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import type { RetentionRun } from '../../database/entities';
import { affected, select } from './retention-sql';
import { RetentionService } from './retention.service';
import type { RetentionJob, RetentionRunContext } from './retention.types';

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
  constructor(private readonly retention: RetentionService) {}

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
