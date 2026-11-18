import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import {
  LEGAL_DOCUMENT_KEYS,
  type LegalConfig,
  type LegalDocumentKey,
  legalLinks,
} from '../../../config/legal.config';
import type { User } from '../../../database/entities';
import { EmailService } from '../../email/email.service';
import { LegalService } from '../legal.service';
import {
  type AnnouncementMailDocument,
  legalAnnouncementMail,
} from './legal-announcement-mail';
import {
  addDays,
  type AnnouncedVersion,
  type AnnouncementInput,
  type AnnouncementProblem,
  berlinToday,
  isValidVersion,
  LEGAL_NOTICE_DAYS,
  AVV_ANNEX_NOTICE_DAYS,
  validateAnnouncement,
} from './legal-announcement.util';

/** Felder einer Ankuendigung, die der Versand und die Vorschau brauchen. */
export interface AnnouncementForMail {
  documents: LegalDocumentKey[];
  version: string;
  previousVersions: Partial<Record<LegalDocumentKey, string>>;
  summaryDe: string;
  summaryEn: string | null;
  shortNotice: boolean;
  explicitConsent: boolean;
  /** Vom AVV nur Anhang B/C (AVV Ziffer 6.3 statt Zustimmung). */
  avvAnnexesOnly: boolean;
}

export interface DeliveryStats {
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export interface AnnouncementListItem extends AnnouncementForMail {
  id: string;
  createdAt: string;
  createdByEmail: string;
  inForce: boolean;
  stats: DeliveryStats;
  /** Bis zu 20 gescheiterte Adressen mit Grund. */
  failures: { email: string; error: string | null }[];
}

/** Hinweis fuer Admins in der App (bis zum Inkrafttreten). */
export interface UpcomingLegalChange {
  id: string;
  documents: LegalDocumentKey[];
  version: string;
  summaryDe: string;
  summaryEn: string | null;
  explicitConsent: boolean;
  avvAnnexesOnly: boolean;
  announcedAt: string;
  links: Partial<
    Record<
      LegalDocumentKey,
      { versionUrl: string; pdfUrl: string; previousUrl: string | null }
    >
  >;
}

/** Admins aller Organisationen, je Adresse einmal (ohne Gross/klein). */
const RECIPIENTS_SQL = `
  SELECT DISTINCT ON (lower(u.email)) u.email, u.first_name
    FROM user_organizations uo
    JOIN organizations o ON o.id = uo.organization_id AND o.deleted_at IS NULL
    JOIN users u ON u.id = uo.user_id AND u.deleted_at IS NULL AND u.is_active = true
   WHERE uo.role = 'admin'
   ORDER BY lower(u.email), u.first_name`;

const EMPTY_STATS: DeliveryStats = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  failed: 0,
};

/** Statuscode einer Adresse (HEAD, bei 405 GET); 0 = nicht erreichbar. */
export type UrlProbe = (url: string) => Promise<number>;

const probeUrl: UrlProbe = async (url) => {
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 405) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
    }
    return res.status;
  } catch {
    return 0;
  }
};

/**
 * Neue Fassungen der Rechtstexte ankuendigen (Super-Admin) und Admins
 * darauf hinweisen.
 *
 * Ablauf: Vorschau (Pruefung + Mail), Anlegen. Beim Anlegen werden die
 * Empfaenger festgehalten — alle Admins aller nicht geloeschten
 * Organisationen, je Adresse einmal; den Versand uebernimmt
 * `LegalAnnouncementMailer` im Hintergrund. Ab dem Datum der Fassung gilt
 * sie (siehe `LegalService.config`).
 */
@Injectable()
export class LegalAnnouncementsService {
  private readonly logger = new Logger(LegalAnnouncementsService.name);
  /** Austauschbar fuer Tests. */
  probe: UrlProbe = probeUrl;

  constructor(
    private readonly dataSource: DataSource,
    private readonly legal: LegalService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  get contactEmail(): string {
    return (
      this.configService.get<string>('platform.contactEmail') ||
      'hello@openeos.de'
    );
  }

  private assertEnabled(): LegalConfig {
    const config = this.legal.config;
    if (!config.enabled) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.LEGAL_TEXTS_DISABLED,
        message:
          'Auf dieser Installation gibt es keine Rechtstexte von LUXCODE.',
      });
    }
    return config;
  }

  /** Mail einer Ankuendigung an eine Adresse. */
  renderMail(
    announcement: AnnouncementForMail,
    recipient: { email: string; firstName: string | null },
    config: LegalConfig = this.legal.config,
  ): { subject: string; html: string } {
    const documents: AnnouncementMailDocument[] = LEGAL_DOCUMENT_KEYS.filter(
      (d) => announcement.documents.includes(d),
    ).map((document) => {
      const next = legalLinks(config, document, announcement.version);
      const previousVersion = announcement.previousVersions[document] ?? null;
      return {
        document,
        versionUrl: next.versionUrl,
        pdfUrl: next.pdfUrl,
        previousVersion,
        previousUrl: previousVersion
          ? legalLinks(config, document, previousVersion).versionUrl
          : null,
      };
    });
    return legalAnnouncementMail({
      to: recipient.email,
      firstName: recipient.firstName,
      version: announcement.version,
      documents,
      summaryDe: announcement.summaryDe,
      summaryEn: announcement.summaryEn,
      shortNotice: announcement.shortNotice,
      explicitConsent: announcement.explicitConsent,
      avvAnnexesOnly: announcement.avvAnnexesOnly,
      contactEmail: this.contactEmail,
      appUrl: this.emailService.appUrl,
    });
  }

  private normalize(input: AnnouncementInput): AnnouncementForMail {
    const documents = LEGAL_DOCUMENT_KEYS.filter((d) =>
      input.documents.includes(d),
    );
    const current = this.legal.config.versions;
    const previousVersions: Partial<Record<LegalDocumentKey, string>> = {};
    for (const d of documents) previousVersions[d] = current[d];
    return {
      documents,
      version: input.version.trim(),
      previousVersions,
      summaryDe: input.summaryDe.trim(),
      summaryEn: input.summaryEn?.trim() || null,
      shortNotice: input.shortNotice === true,
      explicitConsent: input.explicitConsent === true,
      /* Nur mit AVV sinnvoll (sonst lehnt validateAnnouncement ab). */
      avvAnnexesOnly:
        input.avvAnnexesOnly === true && documents.includes('avv'),
    };
  }

  /** Regeln ohne Netz (Frist, Reihenfolge, Text). */
  private validate(
    input: AnnouncementInput,
    announced: readonly AnnouncedVersion[],
  ): AnnouncementProblem[] {
    const config = this.legal.config;
    return validateAnnouncement(input, {
      today: berlinToday(),
      current: config.versions,
      initialVersion: config.initialVersion,
      announced,
    });
  }

  /** Liegt jede neue Fassung schon auf der Website? */
  async checkWebsite(
    documents: readonly LegalDocumentKey[],
    version: string,
  ): Promise<AnnouncementProblem[]> {
    const config = this.legal.config;
    /* Nur ein echtes Datum kommt in die Adresse, neu aus seinen Zahlen
       zusammengesetzt: Host und Pfad stammen aus der Konfiguration, die
       Eingabe kann die Anfrage nirgendwo anders hinlenken. */
    if (!isValidVersion(version)) return [];
    const [y, m, d] = version.split('-').map(Number);
    const safeVersion = new Date(Date.UTC(y, m - 1, d))
      .toISOString()
      .slice(0, 10);
    const allowed = new Set<string>(LEGAL_DOCUMENT_KEYS);
    const results = await Promise.all(
      documents
        .filter((document) => allowed.has(document))
        .map(async (document) => {
          const url = legalLinks(config, document, safeVersion).versionUrl;
          const status = await this.probe(url);
          return { document, url, status };
        }),
    );
    return results
      .filter((r) => r.status < 200 || r.status >= 300)
      .map((r) => ({
        field: 'website' as const,
        document: r.document,
        message: `Die neue Fassung ist auf der Website noch nicht abrufbar: ${r.url} (${r.status ? `HTTP ${r.status}` : 'keine Antwort'}). Veröffentliche zuerst die Datei auf der Website, dann kündige an.`,
      }));
  }

  async countRecipients(): Promise<number> {
    const rows: { count: string }[] = await this.dataSource.query(
      `SELECT count(*)::text AS count FROM (${RECIPIENTS_SQL}) r`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Pruefung und Mail, ohne etwas zu speichern. */
  async preview(
    input: AnnouncementInput,
    user: Pick<User, 'email' | 'firstName'>,
  ) {
    this.assertEnabled();
    await this.legal.refreshAnnouncements();
    const problems = this.validate(input, this.legal.knownAnnouncements);
    const announcement = this.normalize(input);
    if (
      announcement.documents.length &&
      !problems.some((p) => p.field === 'version' || p.field === 'documents')
    ) {
      problems.push(
        ...(await this.checkWebsite(
          announcement.documents,
          announcement.version,
        )),
      );
    }
    const mail = this.renderMail(announcement, {
      email: user.email,
      firstName: user.firstName ?? null,
    });
    return {
      valid: problems.length === 0,
      problems,
      subject: mail.subject,
      html: mail.html,
      recipients: await this.countRecipients(),
      previousVersions: announcement.previousVersions,
    };
  }

  /**
   * Ankuendigung speichern und die Mails einreihen. Eine Sperre in der
   * Transaktion verhindert zwei Ankuendigungen derselben Fassung, wenn zwei
   * Super-Admins gleichzeitig speichern.
   */
  async create(
    input: AnnouncementInput,
    user: Pick<User, 'id' | 'email'>,
  ): Promise<AnnouncementListItem> {
    this.assertEnabled();
    await this.legal.refreshAnnouncements();
    const early = this.validate(input, this.legal.knownAnnouncements);
    const announcement = this.normalize(input);
    const problems = early.length
      ? early
      : await this.checkWebsite(announcement.documents, announcement.version);
    if (problems.length) throw this.invalid(problems);

    const id = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtext('legal_announcements'))`,
      );
      const existing: { documents: LegalDocumentKey[]; version: string }[] =
        await manager.query(
          `SELECT documents, version FROM legal_announcements`,
        );
      const again = this.validate(
        input,
        existing.map((e) => ({ documents: e.documents, version: e.version })),
      );
      if (again.length) throw this.invalid(again);

      const [row]: { id: string }[] = await manager.query(
        `INSERT INTO legal_announcements
           (documents, version, previous_versions, summary_de, summary_en,
            short_notice, explicit_consent, avv_annexes_only, created_by_id,
            created_by_email)
         VALUES ($1::varchar(10)[], $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          announcement.documents,
          announcement.version,
          JSON.stringify(announcement.previousVersions),
          announcement.summaryDe,
          announcement.summaryEn,
          announcement.shortNotice,
          announcement.explicitConsent,
          announcement.avvAnnexesOnly,
          user.id,
          user.email.slice(0, 255),
        ],
      );
      await manager.query(
        `INSERT INTO legal_announcement_deliveries (announcement_id, email, first_name)
         SELECT $1, r.email, r.first_name FROM (${RECIPIENTS_SQL}) r
         ON CONFLICT DO NOTHING`,
        [row.id],
      );
      return row.id;
    });

    await this.legal.refreshAnnouncements();
    this.logger.log(
      `Rechtstexte angekündigt: ${announcement.documents.join(', ')} ab ${announcement.version} (${user.email})`,
    );
    const item = (await this.list()).find((a) => a.id === id);
    return item!;
  }

  private invalid(problems: AnnouncementProblem[]): BadRequestException {
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.LEGAL_ANNOUNCEMENT_INVALID,
      message: problems.map((p) => p.message).join(' '),
      details: problems.map((p) => ({
        field: p.field,
        code: p.document,
        message: p.message,
      })),
    });
  }

  /** Alle Ankuendigungen, neueste zuerst, mit Versandstand. */
  async list(): Promise<AnnouncementListItem[]> {
    const rows: {
      id: string;
      documents: LegalDocumentKey[];
      version: string;
      previous_versions: Partial<Record<LegalDocumentKey, string>>;
      summary_de: string;
      summary_en: string | null;
      short_notice: boolean;
      explicit_consent: boolean;
      avv_annexes_only: boolean;
      created_by_email: string;
      created_at: Date;
    }[] = await this.dataSource.query(
      `SELECT * FROM legal_announcements ORDER BY created_at DESC LIMIT 100`,
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const counts: { announcement_id: string; status: string; n: string }[] =
      await this.dataSource.query(
        `SELECT announcement_id, status, count(*)::text AS n
           FROM legal_announcement_deliveries
          WHERE announcement_id = ANY($1::uuid[])
          GROUP BY announcement_id, status`,
        [ids],
      );
    const failures: {
      announcement_id: string;
      email: string;
      error: string | null;
    }[] = await this.dataSource.query(
      `SELECT announcement_id, email, error FROM (
         SELECT announcement_id, email, error,
                row_number() OVER (PARTITION BY announcement_id ORDER BY email) AS rn
           FROM legal_announcement_deliveries
          WHERE announcement_id = ANY($1::uuid[]) AND status = 'failed'
       ) f WHERE rn <= 20`,
      [ids],
    );
    const today = berlinToday();
    return rows.map((r) => {
      const stats = { ...EMPTY_STATS };
      for (const c of counts.filter((c) => c.announcement_id === r.id)) {
        const n = Number(c.n);
        stats.total += n;
        if (c.status in stats) stats[c.status as keyof DeliveryStats] += n;
      }
      return {
        id: r.id,
        documents: r.documents,
        version: r.version,
        previousVersions: r.previous_versions ?? {},
        summaryDe: r.summary_de,
        summaryEn: r.summary_en,
        shortNotice: r.short_notice,
        explicitConsent: r.explicit_consent,
        avvAnnexesOnly: r.avv_annexes_only,
        createdAt: new Date(r.created_at).toISOString(),
        createdByEmail: r.created_by_email,
        inForce: r.version <= today,
        stats,
        failures: failures
          .filter((f) => f.announcement_id === r.id)
          .map((f) => ({ email: f.email, error: f.error })),
      };
    });
  }

  /** Was die Seite im Super-Admin-Bereich zum Start braucht. */
  async overview() {
    const config = this.assertEnabled();
    await this.legal.refreshAnnouncements();
    const today = berlinToday();
    return {
      initialVersion: config.initialVersion,
      siteUrl: config.siteUrl,
      versions: config.versions,
      today,
      noticeDays: LEGAL_NOTICE_DAYS,
      earliestContractVersion: addDays(today, LEGAL_NOTICE_DAYS),
      avvAnnexNoticeDays: AVV_ANNEX_NOTICE_DAYS,
      earliestAvvAnnexVersion: addDays(today, AVV_ANNEX_NOTICE_DAYS),
      emailEnabled: this.emailService.enabled,
      contactEmail: this.contactEmail,
      recipients: await this.countRecipients(),
      announcements: await this.list(),
    };
  }

  /** Gescheiterte Mails einer Ankuendigung erneut einreihen. */
  async retryFailed(id: string): Promise<number> {
    this.assertEnabled();
    const result: [unknown[], number] = await this.dataSource.query(
      `UPDATE legal_announcement_deliveries
          SET status = 'pending', error = NULL, claimed_at = NULL
        WHERE announcement_id = $1 AND status = 'failed'`,
      [id],
    );
    return result[1] ?? 0;
  }

  // === Hinweis fuer Admins ===

  /**
   * Angekuendigte, noch nicht geltende Fassungen fuer einen Admin, ohne
   * die, die er weggeklickt hat. Mitglieder ohne Admin-Rolle sehen nichts.
   */
  async upcomingFor(userId: string): Promise<UpcomingLegalChange[]> {
    const config = this.legal.config;
    if (!config.enabled) return [];
    const today = berlinToday();
    const upcoming = this.legal.knownAnnouncements.filter(
      (a) => a.version > today,
    );
    if (!upcoming.length) return [];
    const [admin]: { yes: boolean }[] = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM user_organizations uo
           JOIN organizations o ON o.id = uo.organization_id AND o.deleted_at IS NULL
          WHERE uo.user_id = $1 AND uo.role = 'admin'
       ) AS yes`,
      [userId],
    );
    if (!admin?.yes) return [];
    const dismissed: { announcement_id: string }[] =
      await this.dataSource.query(
        `SELECT announcement_id FROM legal_announcement_dismissals
        WHERE user_id = $1 AND announcement_id = ANY($2::uuid[])`,
        [userId, upcoming.map((a) => a.id)],
      );
    const hidden = new Set(dismissed.map((d) => d.announcement_id));
    return upcoming
      .filter((a) => !hidden.has(a.id))
      .map((a) => {
        const links: UpcomingLegalChange['links'] = {};
        for (const d of a.documents) {
          const next = legalLinks(config, d, a.version);
          const current = config.versions[d];
          links[d] = {
            versionUrl: next.versionUrl,
            pdfUrl: next.pdfUrl,
            previousUrl: current
              ? legalLinks(config, d, current).versionUrl
              : null,
          };
        }
        return {
          id: a.id,
          documents: a.documents,
          version: a.version,
          summaryDe: a.summaryDe,
          summaryEn: a.summaryEn,
          explicitConsent: a.explicitConsent,
          avvAnnexesOnly: a.avvAnnexesOnly,
          announcedAt: a.createdAt.toISOString(),
          links,
        };
      });
  }

  async dismiss(userId: string, announcementId: string): Promise<void> {
    if (!this.legal.knownAnnouncements.some((a) => a.id === announcementId)) {
      await this.legal.refreshAnnouncements();
      if (!this.legal.knownAnnouncements.some((a) => a.id === announcementId)) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.LEGAL_ANNOUNCEMENT_NOT_FOUND,
          message: 'Diese Ankündigung gibt es nicht.',
        });
      }
    }
    await this.dataSource.query(
      `INSERT INTO legal_announcement_dismissals (announcement_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [announcementId, userId],
    );
  }
}
