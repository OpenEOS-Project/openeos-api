import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  LegalAcceptance,
  LegalAcceptanceContext,
  LegalDocument,
  LEGAL_DOCUMENTS,
} from '../../database/entities/legal-acceptance.entity';
import type { User } from '../../database/entities';
import {
  currentLegalLinks,
  isAfterInitialVersion,
  LegalConfig,
  legalConfigFromEnv,
  LegalDocumentKey,
  LegalDocumentLinks,
  legalLinks,
} from '../../config/legal.config';
import { EmailService, LegalEmailDocument } from '../email/email.service';
import {
  berlinToday,
  effectiveLegalVersions,
} from './announcements/legal-announcement.util';

/** Wer und von wo — wie bei den Sitzungen. */
export interface AcceptanceClient {
  ip?: string;
  userAgent?: string;
}

export interface LegalDocumentStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  upToDate: boolean;
  /**
   * Muss der Benutzer dieses Dokument jetzt (erneut) annehmen? Nur diese
   * Dokumente nennt der Dialog, und nur sie haelt `accept` ohne Angabe
   * von Dokumenten fest.
   */
  reacceptanceRequired: boolean;
  acceptedUrl: string | null;
  acceptedPdfUrl: string | null;
}

/** Angekuendigte Fassung, wie die API sie im Speicher haelt. */
export interface KnownAnnouncement {
  id: string;
  documents: LegalDocumentKey[];
  version: string;
  summaryDe: string;
  summaryEn: string | null;
  shortNotice: boolean;
  explicitConsent: boolean;
  /** Vom AVV nur Anhang B/C (AVV Ziffer 6.3). */
  avvAnnexesOnly: boolean;
  createdAt: Date;
}

/** Die angekuendigte Aenderung, mit der die aktuelle AGB/AVV gilt. */
export interface LegalChange {
  version: string;
  documents: LegalDocumentKey[];
  announcedAt: string;
  summaryDe: string;
  summaryEn: string | null;
  /** Nur mit ausdruecklicher Zustimmung wirksam (nicht aufschiebbar). */
  explicitConsent: boolean;
  /** Vom AVV nur Anhang B/C: Widerspruchsrecht nach AVV Ziffer 6.3. */
  avvAnnexesOnly: boolean;
}

export interface LegalStatus {
  /** Muss der Benutzer AGB/AVV/Anlage 1 (erneut) annehmen? */
  required: boolean;
  documents: Record<LegalDocument, LegalDocumentStatus>;
  /**
   * Ankuendigung zur geltenden AGB-/AVV-Fassung (Zusammenfassung, Datum der
   * Mail); `null`, wenn die Fassung nicht angekuendigt wurde.
   */
  change: LegalChange | null;
}

/** Wie oft die angekuendigten Fassungen neu gelesen werden. */
const ANNOUNCEMENT_REFRESH_MS = 60_000;

/** Anlage 1 ist Teil der AGB (Ziffer 4.2, 8.1) und steht in den Mails mit. */
export const ANLAGE1_LABEL =
  'Anlage 1 zu den AGB – Leistungsbeschreibung und Preisliste';

export const LEGAL_LABELS: Record<LegalDocument, string> = {
  agb: 'Allgemeine Geschäftsbedingungen (AGB)',
  avv: 'Auftragsverarbeitungsvertrag (AVV)',
  anlage1: ANLAGE1_LABEL,
};

/** Die Zeilen, die eine Annahme schreibt (eine je Dokument). */
export function acceptanceRows(input: {
  config: LegalConfig;
  user: Pick<User, 'id' | 'email'>;
  organization: { id: string; name: string } | null;
  documents: readonly LegalDocument[];
  context: LegalAcceptanceContext;
  businessConfirmed?: boolean;
  client?: AcceptanceClient;
}): Partial<LegalAcceptance>[] {
  return input.documents.map((document) => ({
    userId: input.user.id,
    userEmail: input.user.email.slice(0, 255),
    organizationId: input.organization?.id ?? null,
    organizationName: input.organization?.name.slice(0, 200) ?? null,
    document,
    version: input.config.versions[document],
    context: input.context,
    businessConfirmed: input.businessConfirmed === true,
    ipAddress: input.client?.ip ? input.client.ip.slice(0, 45) : null,
    userAgent: input.client?.userAgent
      ? input.client.userAgent.slice(0, 500)
      : null,
  }));
}

/**
 * Muss ein Admin dieses Dokument erneut annehmen? Nur wenn die aktuelle
 * Fassung nach der Ausgangsfassung liegt (`LEGAL_INITIAL_VERSION`) und er
 * sie noch nicht angenommen hat. Fassungen bis zur Ausgangsfassung fragen
 * niemanden — auch nicht, wer eine aeltere Fassung oder gar keine
 * angenommen hat (Konten aus der Testphase).
 */
export function reacceptanceNeeded(
  config: Pick<LegalConfig, 'versions' | 'initialVersion'>,
  document: LegalDocument,
  acceptedVersion: string | null,
): boolean {
  const current = config.versions[document];
  if (!isAfterInitialVersion(current, config.initialVersion)) return false;
  // ISO-Datum: lexikografisch = zeitlich.
  return !acceptedVersion || acceptedVersion < current;
}

/**
 * Annahme von AGB, Auftragsverarbeitungsvertrag (AVV) und Anlage 1,
 * versioniert nach dem Datum der „Stand“-Zeile.
 *
 * Admins einer Organisation muessen die aktuelle Fassung jedes Dokuments
 * angenommen haben, sobald sie nach der Ausgangsfassung liegt
 * (`reacceptanceNeeded`); dann meldet `/auth/me`
 * `legalReacceptanceRequired` und die Oberflaeche fragt erneut.
 */
@Injectable()
export class LegalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LegalService.name);
  /** Angekuendigte Fassungen (legal_announcements), sortiert nach Fassung. */
  private announcements: KnownAnnouncement[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(LegalAcceptance)
    private readonly acceptances: Repository<LegalAcceptance>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  /** Fassungen aus Code bzw. Umgebung, ohne Ankuendigungen. */
  get baseConfig(): LegalConfig {
    return (
      this.configService.get<LegalConfig>('legal') ??
      legalConfigFromEnv({}, false)
    );
  }

  /**
   * Geltende Konfiguration: je Dokument die neuere von Code/Umgebung und
   * der neuesten angekuendigten Fassung, deren Tag erreicht ist (siehe
   * legal-announcement.util.ts).
   */
  get config(): LegalConfig {
    const base = this.baseConfig;
    if (!base.enabled || !this.announcements.length) return base;
    return {
      ...base,
      versions: effectiveLegalVersions(
        base.versions,
        this.announcements,
        berlinToday(),
      ),
    };
  }

  onModuleInit(): void {
    if (!this.baseConfig.enabled) return;
    void this.refreshAnnouncements();
    this.refreshTimer = setInterval(
      () => void this.refreshAnnouncements(),
      ANNOUNCEMENT_REFRESH_MS,
    );
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Alle angekuendigten Fassungen (auch kuenftige), aelteste zuerst. */
  get knownAnnouncements(): readonly KnownAnnouncement[] {
    return this.announcements;
  }

  /**
   * Angekuendigte Fassungen neu lesen — beim Start, jede Minute und nach
   * einer neuen Ankuendigung. Scheitert das, bleibt der letzte Stand.
   */
  async refreshAnnouncements(): Promise<void> {
    try {
      const rows: {
        id: string;
        documents: LegalDocumentKey[];
        version: string;
        summary_de: string;
        summary_en: string | null;
        short_notice: boolean;
        explicit_consent: boolean;
        avv_annexes_only: boolean;
        created_at: Date;
      }[] = await this.dataSource.query(
        `SELECT id, documents, version, summary_de, summary_en, short_notice,
                explicit_consent, avv_annexes_only, created_at
           FROM legal_announcements
          ORDER BY version, created_at`,
      );
      this.announcements = rows.map((r) => ({
        id: r.id,
        documents: r.documents,
        version: r.version,
        summaryDe: r.summary_de,
        summaryEn: r.summary_en,
        shortNotice: r.short_notice,
        explicitConsent: r.explicit_consent,
        avvAnnexesOnly: r.avv_annexes_only === true,
        createdAt: new Date(r.created_at),
      }));
    } catch (error) {
      this.logger.warn(
        `Angekündigte Fassungen nicht gelesen: ${(error as Error).message}`,
      );
    }
  }

  /** Ankuendigung, mit der die geltende AGB-, AVV- bzw. Anlage-1-Fassung kam. */
  currentChange(config: LegalConfig = this.config): LegalChange | null {
    for (let i = this.announcements.length - 1; i >= 0; i--) {
      const a = this.announcements[i];
      const matches = LEGAL_DOCUMENTS.some(
        (d) => a.documents.includes(d) && config.versions[d] === a.version,
      );
      if (!matches) continue;
      return {
        version: a.version,
        documents: a.documents,
        announcedAt: a.createdAt.toISOString(),
        summaryDe: a.summaryDe,
        summaryEn: a.summaryEn,
        explicitConsent: a.explicitConsent,
        avvAnnexesOnly: a.avvAnnexesOnly,
      };
    }
    return null;
  }

  versions(): {
    enabled: boolean;
    siteUrl: string;
    documents: Record<
      'agb' | 'avv' | 'privacy' | 'imprint' | 'anlage1',
      LegalDocumentLinks
    >;
  } {
    const config = this.config;
    return {
      enabled: config.enabled,
      siteUrl: config.siteUrl,
      documents: currentLegalLinks(config),
    };
  }

  /** Letzte Annahme je Dokument. */
  private async latest(
    userId: string,
  ): Promise<Partial<Record<LegalDocument, LegalAcceptance>>> {
    const rows = await this.acceptances
      .createQueryBuilder('a')
      .distinctOn(['a.document'])
      .where('a.user_id = :userId', { userId })
      .orderBy('a.document')
      .addOrderBy('a.version', 'DESC')
      .addOrderBy('a.accepted_at', 'DESC')
      .getMany();
    const result: Partial<Record<LegalDocument, LegalAcceptance>> = {};
    for (const row of rows) result[row.document] = row;
    return result;
  }

  /** Organisationen, in denen der Benutzer Admin ist (ohne geloeschte). */
  private async adminOrganizations(
    userId: string,
  ): Promise<{ id: string; name: string }[]> {
    const rows: { id: string; name: string }[] = await this.dataSource.query(
      `SELECT o.id, o.name
         FROM user_organizations uo
         JOIN organizations o ON o.id = uo.organization_id AND o.deleted_at IS NULL
        WHERE uo.user_id = $1 AND uo.role = 'admin'
        ORDER BY o.name`,
      [userId],
    );
    return rows;
  }

  async status(userId: string): Promise<LegalStatus> {
    const config = this.config;
    const [latest, admin] = await Promise.all([
      this.latest(userId),
      config.enabled ? this.adminOrganizations(userId) : Promise.resolve([]),
    ]);
    const asking =
      config.enabled && config.reacceptanceEnabled && admin.length > 0;
    const documents = {} as Record<LegalDocument, LegalDocumentStatus>;
    for (const document of LEGAL_DOCUMENTS) {
      const row = latest[document];
      const current = config.versions[document];
      const links = row ? legalLinks(config, document, row.version) : null;
      documents[document] = {
        currentVersion: current,
        acceptedVersion: row?.version ?? null,
        acceptedAt: row?.acceptedAt ? row.acceptedAt.toISOString() : null,
        // ISO-Datum: lexikografisch = zeitlich.
        upToDate: !!row && row.version >= current,
        reacceptanceRequired:
          asking && reacceptanceNeeded(config, document, row?.version ?? null),
        acceptedUrl: links?.versionUrl ?? null,
        acceptedPdfUrl: links?.pdfUrl ?? null,
      };
    }
    const required = LEGAL_DOCUMENTS.some(
      (d) => documents[d].reacceptanceRequired,
    );
    return { required, documents, change: this.currentChange(config) };
  }

  async isReacceptanceRequired(userId: string): Promise<boolean> {
    if (!this.config.enabled || !this.config.reacceptanceEnabled) return false;
    try {
      return (await this.status(userId)).required;
    } catch (error) {
      /* Nie die Anmeldung blockieren, nur weil die Abfrage scheitert. */
      this.logger.warn(
        `Annahme-Status nicht ermittelt: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Aktuelle Fassungen annehmen. Ohne Organisation gilt die Annahme fuer
   * jede Organisation, in der der Benutzer Admin ist (eine Zeile je
   * Organisation und Dokument); hat er keine, eine Zeile ohne Organisation.
   */
  async accept(
    user: Pick<User, 'id' | 'email'>,
    input: {
      documents?: LegalDocument[];
      context?: LegalAcceptanceContext;
      organizationId?: string;
    },
    client?: AcceptanceClient,
  ): Promise<LegalStatus> {
    const config = this.config;
    const context = input.context ?? 'reacceptance';
    /* Ohne Angabe: beim Buchen alle Dokumente, bei der erneuten Annahme
       nur die, die sie verlangen (wie im Dialog genannt) — eine unveraenderte
       Fassung wird nicht noch einmal als „erneut angenommen“ vermerkt. */
    let documents: LegalDocument[];
    if (input.documents?.length) {
      documents = [...new Set(input.documents)];
    } else if (context === 'reacceptance') {
      const current = await this.status(user.id);
      documents = LEGAL_DOCUMENTS.filter(
        (d) => current.documents[d].reacceptanceRequired,
      );
      if (!documents.length) return current;
    } else {
      documents = [...LEGAL_DOCUMENTS];
    }

    let organizations: ({ id: string; name: string } | null)[];
    if (input.organizationId) {
      const rows: { id: string; name: string }[] = await this.dataSource.query(
        `SELECT o.id, o.name
           FROM user_organizations uo
           JOIN organizations o ON o.id = uo.organization_id AND o.deleted_at IS NULL
          WHERE uo.user_id = $1 AND o.id = $2`,
        [user.id, input.organizationId],
      );
      // Fremde Organisation: ohne Bezug speichern statt einen Namen zu verraten.
      organizations = rows.length ? [rows[0]] : [null];
    } else {
      const admin = await this.adminOrganizations(user.id);
      organizations = admin.length ? admin : [null];
    }

    const rows = organizations.flatMap((organization) =>
      acceptanceRows({
        config,
        user,
        organization,
        documents,
        context,
        client,
      }),
    );
    await this.acceptances.insert(rows);
    this.logger.log(
      `Rechtstexte angenommen: user=${user.id} ${documents
        .map((d) => `${d}@${config.versions[d]}`)
        .join(', ')} (${context})`,
    );
    return this.status(user.id);
  }

  /** Links auf die Fassungen, die eine Mail nennt. */
  emailDocuments(
    versions?: Partial<Record<LegalDocument, string>>,
  ): LegalEmailDocument[] {
    const config = this.config;
    /* Anlage 1 gehoert zu den AGB (Leistungsumfang, Preise) und steht nach
       ihnen und dem AVV in der Mail. */
    return LEGAL_DOCUMENTS.map((document) => {
      const links = legalLinks(
        config,
        document,
        versions?.[document] ?? config.versions[document],
      );
      return {
        label: LEGAL_LABELS[document],
        version: links.version,
        versionUrl: links.versionUrl,
        pdfUrl: links.pdfUrl,
      };
    });
  }

  /** Bestaetigung nach der Registrierung (best effort). */
  async sendRegistrationEmail(input: {
    user: Pick<User, 'email' | 'firstName'>;
    organizationName: string | null;
    acceptedAt: Date;
  }): Promise<void> {
    const config = this.config;
    if (!config.enabled) return;
    try {
      const privacy = legalLinks(config, 'privacy', config.versions.privacy);
      await this.emailService.sendRegistrationLegalEmail({
        to: input.user.email,
        firstName: input.user.firstName,
        organizationName: input.organizationName,
        acceptedAt: input.acceptedAt,
        documents: this.emailDocuments(),
        privacy: { url: privacy.url, pdfUrl: privacy.pdfUrl },
      });
    } catch (error) {
      this.logger.warn(
        `Registrierungsbestätigung nicht gesendet: ${(error as Error).message}`,
      );
    }
  }
}
