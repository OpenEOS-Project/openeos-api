import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { DeploymentService } from '../../common/services/deployment.service';
import {
  ContentReport,
  type ContentReportStatus,
} from '../../database/entities/content-report.entity';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import {
  defaultRedress,
  parseReportTarget,
  REASON_LABELS,
  statementRows,
} from './content-report.util';
import type {
  ContentReportNotifyTarget,
  CreateContentReportDto,
  UpdateContentReportDto,
} from './dto';

/** Schneller abgeschickt gilt als automatisiert. */
const MIN_FILL_TIME_MS = 3000;
/** Obergrenze je Tag ueber alle Absender — schuetzt Speicher und Postfach. */
const DAILY_LIMIT = 200;
/** Gleiche Fundstelle vom gleichen Absender: einmal pro Tag genuegt. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const SUCCESS = {
  message:
    'Danke für deine Meldung. Wir haben sie erhalten und prüfen sie. Eine Eingangsbestätigung schicken wir dir per E-Mail.',
};

export interface ContentReportView extends ContentReport {
  organizationName: string | null;
  eventName: string | null;
  shiftPlanName: string | null;
  /** Rechtsbehelfe, die eine Mitteilung tatsaechlich nennt. */
  effectiveRedress: string;
}

/**
 * Melde- und Abhilfeverfahren fuer oeffentliche Seiten mit Inhalten der
 * Vereine (Art. 16 DSA) und Begruendung von Entscheidungen (Art. 17 DSA).
 *
 * Missbrauchsschutz ohne Captcha: Honeypot, Mindest-Ausfuellzeit,
 * Rate-Limit je IP (Controller), Doppelmeldungen und Tagesobergrenze.
 */
@Injectable()
export class ContentReportsService {
  private readonly logger = new Logger(ContentReportsService.name);

  constructor(
    @InjectRepository(ContentReport)
    private readonly reports: Repository<ContentReport>,
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly deployment: DeploymentService,
  ) {}

  private get contactEmail(): string | null {
    return this.deployment.platformLegal.contactEmail;
  }

  async submit(
    dto: CreateContentReportDto,
    now = new Date(),
  ): Promise<{ message: string }> {
    if (dto.website?.trim()) {
      this.logger.debug('Meldung verworfen: Honeypot-Feld befüllt');
      return SUCCESS;
    }
    if (now.getTime() - dto.startedAt < MIN_FILL_TIME_MS) {
      this.logger.debug('Meldung verworfen: Formular zu schnell abgesendet');
      return SUCCESS;
    }

    const url = dto.url.trim();
    const email = dto.email.trim().toLowerCase();

    const duplicate = await this.reports.count({
      where: {
        url,
        reporterEmail: email,
        createdAt: MoreThan(new Date(now.getTime() - DUPLICATE_WINDOW_MS)),
      },
    });
    if (duplicate > 0) return SUCCESS;

    const today = await this.reports.count({
      where: {
        createdAt: MoreThan(new Date(now.getTime() - DUPLICATE_WINDOW_MS)),
      },
    });
    if (today >= DAILY_LIMIT) {
      this.logger.warn(
        `Meldungen pausiert: ${today} Meldungen in 24 Stunden (Obergrenze ${DAILY_LIMIT})`,
      );
      throw new HttpException(
        {
          code: ErrorCodes.RATE_LIMITED,
          reason: ErrorReasons.CONTENT_REPORTS_PAUSED,
          message: this.contactEmail
            ? `Gerade gehen sehr viele Meldungen ein. Bitte schreib uns direkt an ${this.contactEmail}.`
            : 'Gerade gehen sehr viele Meldungen ein. Bitte versuche es später noch einmal.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const target = await this.resolveTarget(url);
    const report = await this.reports.save(
      this.reports.create({
        url,
        reason: dto.reason,
        description: dto.description.trim(),
        reporterName: dto.name.trim(),
        reporterEmail: email,
        goodFaith: dto.goodFaith === true,
        status: 'open',
        ...target,
      }),
    );
    this.logger.log(
      `Inhaltsmeldung ${report.id} (${report.reason}, ${report.targetType}) eingegangen`,
    );

    await this.sendReceipt(report);
    await this.notifyPlatformAdmin(report);
    return SUCCESS;
  }

  /** Organisation, Veranstaltung bzw. Schichtplan zur Fundstelle. */
  async resolveTarget(
    url: string,
  ): Promise<
    Pick<
      ContentReport,
      'targetType' | 'organizationId' | 'eventId' | 'shiftPlanId'
    >
  > {
    const none = {
      targetType: 'unknown' as const,
      organizationId: null,
      eventId: null,
      shiftPlanId: null,
    };
    const target = parseReportTarget(url);
    if (!target) return none;
    try {
      if (target.kind === 'event') {
        const rows: { id: string; organization_id: string }[] =
          await this.dataSource.query(
            `SELECT id, organization_id FROM events WHERE id = $1`,
            [target.eventId],
          );
        if (!rows.length) return none;
        return {
          targetType: 'shop',
          organizationId: rows[0].organization_id,
          eventId: rows[0].id,
          shiftPlanId: null,
        };
      }
      const rows: { id: string; organization_id: string }[] =
        await this.dataSource.query(
          `SELECT id, organization_id FROM shift_plans WHERE public_slug = $1`,
          [target.slug],
        );
      if (!rows.length) return none;
      return {
        targetType: 'helper_page',
        organizationId: rows[0].organization_id,
        eventId: null,
        shiftPlanId: rows[0].id,
      };
    } catch (error) {
      this.logger.warn(
        `Fundstelle nicht zugeordnet: ${(error as Error).message}`,
      );
      return none;
    }
  }

  private async sendReceipt(report: ContentReport): Promise<void> {
    try {
      const sent = await this.emailService.sendContentReportReceipt({
        to: report.reporterEmail,
        name: report.reporterName,
        url: report.url,
        reason: REASON_LABELS[report.reason],
        description: report.description,
        receivedAt: report.createdAt,
        contactEmail: this.contactEmail,
      });
      if (sent) {
        await this.reports.update(
          { id: report.id },
          { receiptSentAt: new Date() },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Eingangsbestätigung (Meldung ${report.id}) nicht gesendet: ${(error as Error).message}`,
      );
    }
  }

  private async notifyPlatformAdmin(report: ContentReport): Promise<void> {
    try {
      const to = await this.platformSettings.resolvePlatformAdminEmail();
      if (!to) {
        this.logger.warn(
          'Keine Betreiber-Adresse hinterlegt — die Meldung liegt nur in der Datenbank.',
        );
        return;
      }
      const sent = await this.emailService.sendAdminContentReportNotification({
        to,
        url: report.url,
        reason: REASON_LABELS[report.reason],
        description: report.description,
        reporterName: report.reporterName,
        reporterEmail: report.reporterEmail,
        targetType: report.targetType,
        adminPath: `/admin/reports?id=${report.id}`,
      });
      if (sent) {
        await this.reports.update(
          { id: report.id },
          { adminNotifiedAt: new Date() },
        );
      }
    } catch (error) {
      this.logger.warn(
        `Benachrichtigung (Meldung ${report.id}) fehlgeschlagen: ${(error as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Super-Admin
  // ---------------------------------------------------------------------------

  async list(filter: {
    status?: ContentReportStatus;
  }): Promise<ContentReportView[]> {
    const qb = this.reports
      .createQueryBuilder('r')
      .orderBy('r.created_at', 'DESC')
      .take(200);
    if (filter.status)
      qb.where('r.status = :status', { status: filter.status });
    return this.withNames(await qb.getMany());
  }

  async get(id: string): Promise<ContentReportView> {
    return (await this.withNames([await this.load(id)]))[0];
  }

  private async load(id: string): Promise<ContentReport> {
    const report = await this.reports.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.CONTENT_REPORT_NOT_FOUND,
        message: 'Meldung nicht gefunden',
      });
    }
    return report;
  }

  private async withNames(
    reports: ContentReport[],
  ): Promise<ContentReportView[]> {
    const ids = (pick: (r: ContentReport) => string | null) => [
      ...new Set(reports.map(pick).filter((v): v is string => !!v)),
    ];
    const names = async (table: string, list: string[]) => {
      if (!list.length) return new Map<string, string>();
      const rows: { id: string; name: string }[] = await this.dataSource.query(
        `SELECT id, name FROM ${table} WHERE id = ANY($1::uuid[])`,
        [list],
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    };
    const [orgs, events, plans] = await Promise.all([
      names(
        'organizations',
        ids((r) => r.organizationId),
      ),
      names(
        'events',
        ids((r) => r.eventId),
      ),
      names(
        'shift_plans',
        ids((r) => r.shiftPlanId),
      ),
    ]);
    return reports.map((r) => ({
      ...r,
      organizationName: r.organizationId
        ? (orgs.get(r.organizationId) ?? null)
        : null,
      eventName: r.eventId ? (events.get(r.eventId) ?? null) : null,
      shiftPlanName: r.shiftPlanId ? (plans.get(r.shiftPlanId) ?? null) : null,
      effectiveRedress: r.redress?.trim() || defaultRedress(this.contactEmail),
    }));
  }

  /**
   * Status, Entscheidung und Begruendung speichern. `disable_shop` wird
   * einmalig ausgefuehrt: Shop der Veranstaltung aus bzw. Helferseite
   * zurueck in den Entwurf (nicht mehr oeffentlich).
   */
  async update(
    id: string,
    dto: UpdateContentReportDto,
    userId: string,
  ): Promise<ContentReportView> {
    const report = await this.load(id);
    const text = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() || null;

    if (dto.status !== undefined) {
      report.status = dto.status;
      report.closedAt =
        dto.status === 'closed' ? (report.closedAt ?? new Date()) : null;
    }
    if (dto.action !== undefined) report.action = dto.action;
    for (const key of ['decision', 'facts', 'ground', 'redress'] as const) {
      const value = text(dto[key]);
      if (value !== undefined) report[key] = value;
    }
    report.handledBy = userId;

    if (report.action === 'disable_shop' && !report.actionAppliedAt) {
      if (await this.applyDisable(report)) {
        report.actionAppliedAt = new Date();
      }
    }

    await this.reports.save(report);
    return this.get(report.id);
  }

  private async applyDisable(report: ContentReport): Promise<boolean> {
    if (report.eventId) {
      await this.dataSource.query(
        `UPDATE events
            SET settings = jsonb_set(
                  COALESCE(settings, '{}'::jsonb),
                  '{shop}',
                  COALESCE(settings->'shop', '{}'::jsonb) || '{"enabled": false}'::jsonb
                ),
                updated_at = now()
          WHERE id = $1`,
        [report.eventId],
      );
      this.logger.warn(
        `Meldung ${report.id}: Shop der Veranstaltung ${report.eventId} abgeschaltet`,
      );
      return true;
    }
    if (report.shiftPlanId) {
      await this.dataSource.query(
        `UPDATE shift_plans SET status = 'draft', updated_at = now() WHERE id = $1`,
        [report.shiftPlanId],
      );
      this.logger.warn(
        `Meldung ${report.id}: Helferseite ${report.shiftPlanId} nicht mehr veröffentlicht`,
      );
      return true;
    }
    return false;
  }

  /** Entscheidung an den Meldenden bzw. Begruendung an den Verein mailen. */
  async notify(
    id: string,
    target: ContentReportNotifyTarget,
  ): Promise<ContentReportView> {
    const report = await this.get(id);
    const rows = statementRows({
      action: report.action,
      decision: report.decision,
      facts: report.facts,
      ground: report.ground,
      redress: report.effectiveRedress,
      url: report.url,
      reportedAt: report.createdAt,
    });

    if (target === 'reporter') {
      const sent = await this.emailService.sendContentReportDecision({
        to: [report.reporterEmail],
        audience: 'reporter',
        name: report.reporterName,
        rows,
        contactEmail: this.contactEmail,
      });
      if (!sent) throw this.mailFailed();
      await this.reports.update(
        { id: report.id },
        { reporterNotifiedAt: new Date() },
      );
    } else {
      const recipients = report.organizationId
        ? await this.organizationRecipients(report.organizationId)
        : [];
      if (!recipients.length) {
        throw new HttpException(
          {
            code: ErrorCodes.VALIDATION_ERROR,
            reason: ErrorReasons.CONTENT_REPORT_NOT_FOUND,
            message:
              'Zu dieser Meldung gehört kein Verein mit Admin-Adresse – die Begründung kann nicht verschickt werden.',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const sent = await this.emailService.sendContentReportDecision({
        to: recipients,
        audience: 'organization',
        name: report.organizationName,
        rows,
        contactEmail: this.contactEmail,
      });
      if (!sent) throw this.mailFailed();
      await this.reports.update(
        { id: report.id },
        { organizationNotifiedAt: new Date() },
      );
    }
    return this.get(report.id);
  }

  private mailFailed(): HttpException {
    return new HttpException(
      {
        code: ErrorCodes.INTERNAL_ERROR,
        message:
          'Die E-Mail konnte nicht verschickt werden. Bitte prüfe den Mailversand und versuche es noch einmal.',
      },
      HttpStatus.BAD_GATEWAY,
    );
  }

  /** Admins des Vereins; ohne Admins die Rechnungsadresse. */
  private async organizationRecipients(
    organizationId: string,
  ): Promise<string[]> {
    const rows: { email: string }[] = await this.dataSource.query(
      `SELECT DISTINCT u.email FROM user_organizations uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.organization_id = $1 AND uo.role = 'admin'
          AND u.deleted_at IS NULL AND u.is_active = true`,
      [organizationId],
    );
    if (rows.length) return rows.map((r) => r.email);
    const billing: { billing_email: string | null }[] =
      await this.dataSource.query(
        `SELECT billing_email FROM organizations WHERE id = $1`,
        [organizationId],
      );
    return billing[0]?.billing_email ? [billing[0].billing_email] : [];
  }
}
