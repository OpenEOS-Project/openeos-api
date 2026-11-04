import { daysBefore } from '../retention.config';
import { affected } from '../retention-sql';
import type { RetentionJob, RetentionRunContext } from '../retention.types';

/**
 * Eintraege im Admin-Protokoll, die Abrechnung, Cloud-TSE, Kassenabschluesse
 * oder die Betriebsart betreffen, sind Nachweise (Buchung, Verfahren) und
 * bleiben; ihnen werden nach Ablauf nur IP-Adresse und Browser entzogen.
 */
const EVIDENCE_ACTIONS = [
  'credit_adjustment',
  'delete_organization',
  'mark_invoice_paid',
  'complete_purchase',
  'set_discount',
  'remove_discount',
  'set_operating_mode',
  'set_organization_country',
  'set_cash_policy',
];
const EVIDENCE_PREFIXES = ['event_', 'tse_', 'dsfinvk_'];

const EVIDENCE_SQL = `(action::text = ANY($2::text[])
  OR action::text LIKE ANY($3::text[]))`;

/** Platzhalter fuer die Pflichtspalte `ip_address`. */
export const REMOVED_IP = 'removed';

/**
 * Sicherheits- und Aenderungsprotokolle nach `RETENTION_AUDIT_LOG_DAYS`
 * (90) Tagen: Admin-Protokoll loeschen bzw. bei Nachweisen pseudonymisieren,
 * IP-Adresse und Browser aus den Aenderungsprotokollen der Betriebsart
 * entfernen. Ausserdem das eigene Protokoll der Loeschlaeufe nach
 * `RETENTION_RUN_LOG_YEARS` (3) Jahren. Ankuendigungen (`retention_notices`)
 * bleiben: sie enthalten nur Kennungen und Daten und markieren, welche
 * Organisation bereits endgueltig geloescht ist.
 */
export class AuditLogsJob implements RetentionJob {
  readonly category = 'audit_logs' as const;

  async run(ctx: RetentionRunContext): Promise<void> {
    const { manager, now } = ctx;
    const cutoff = daysBefore(now, ctx.config.auditLogDays);
    const evidence = [
      cutoff,
      EVIDENCE_ACTIONS,
      EVIDENCE_PREFIXES.map((p) => `${p}%`),
    ];

    ctx.removed(
      'auditEntriesDeleted',
      await affected(
        manager,
        `DELETE FROM admin_audit_logs
          WHERE created_at < $1 AND NOT ${EVIDENCE_SQL}`,
        evidence,
      ),
    );
    ctx.removed(
      'auditEntriesPseudonymised',
      await affected(
        manager,
        `UPDATE admin_audit_logs SET ip_address = '${REMOVED_IP}', user_agent = NULL
          WHERE created_at < $1 AND ${EVIDENCE_SQL}
            AND (ip_address NOT IN ('${REMOVED_IP}', 'system') OR user_agent IS NOT NULL)`,
        evidence,
      ),
    );

    for (const [table, key] of [
      ['organization_cash_policy_changes', 'cashPolicyChangesPseudonymised'],
      ['organization_operating_mode_changes', 'modeChangesPseudonymised'],
      ['organization_cashless_changes', 'cashlessChangesPseudonymised'],
    ] as const) {
      ctx.removed(
        key,
        await affected(
          manager,
          `UPDATE ${table} SET ip_address = NULL, user_agent = NULL
            WHERE created_at < $1
              AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)`,
          [cutoff],
        ),
      );
    }

    const runLogCutoff = new Date(now.getTime());
    runLogCutoff.setUTCFullYear(
      runLogCutoff.getUTCFullYear() - ctx.config.runLogYears,
    );
    ctx.removed(
      'runLogEntriesDeleted',
      await affected(
        manager,
        `DELETE FROM retention_runs WHERE started_at < $1 AND status <> 'running'`,
        [runLogCutoff],
      ),
    );
  }
}
