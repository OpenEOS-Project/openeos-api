import { Injectable, Logger } from '@nestjs/common';
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
  LegalConfig,
  legalConfigFromEnv,
  LegalDocumentLinks,
  legalLinks,
} from '../../config/legal.config';
import { EmailService, LegalEmailDocument } from '../email/email.service';

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
  acceptedUrl: string | null;
  acceptedPdfUrl: string | null;
}

export interface LegalStatus {
  /** Muss der Benutzer AGB/AVV (erneut) annehmen? */
  required: boolean;
  documents: Record<LegalDocument, LegalDocumentStatus>;
}

export const LEGAL_LABELS: Record<LegalDocument, string> = {
  agb: 'Allgemeine Geschäftsbedingungen (AGB)',
  avv: 'Auftragsverarbeitungsvertrag (AVV)',
};

/** Anlage 1 ist Teil der AGB (Ziffer 4.2, 8.1) und steht in den Mails mit. */
export const ANLAGE1_LABEL =
  'Anlage 1 zu den AGB – Leistungsbeschreibung und Preisliste';

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
 * Annahme von AGB und Auftragsverarbeitungsvertrag (AVV), versioniert nach
 * dem Datum der „Stand“-Zeile.
 *
 * Admins einer Organisation muessen die aktuelle Fassung beider Dokumente
 * angenommen haben; liegt ihre letzte Annahme vor der aktuellen Fassung
 * (oder gibt es keine, wie bei Bestandskonten), meldet `/auth/me`
 * `legalReacceptanceRequired` und die Oberflaeche fragt erneut.
 */
@Injectable()
export class LegalService {
  private readonly logger = new Logger(LegalService.name);

  constructor(
    @InjectRepository(LegalAcceptance)
    private readonly acceptances: Repository<LegalAcceptance>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  get config(): LegalConfig {
    return (
      this.configService.get<LegalConfig>('legal') ??
      legalConfigFromEnv({}, false)
    );
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
        acceptedUrl: links?.versionUrl ?? null,
        acceptedPdfUrl: links?.pdfUrl ?? null,
      };
    }
    /* Erneut gefragt wird nur mit LEGAL_REACCEPTANCE_ENABLED=true — die
       Annahme bei Registrierung und Buchung bleibt davon unberuehrt. */
    const required =
      config.enabled &&
      config.reacceptanceEnabled &&
      admin.length > 0 &&
      LEGAL_DOCUMENTS.some((d) => !documents[d].upToDate);
    return { required, documents };
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
    const documents = input.documents?.length
      ? [...new Set(input.documents)]
      : [...LEGAL_DOCUMENTS];
    const context = input.context ?? 'reacceptance';

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
    const documents = LEGAL_DOCUMENTS.map((document) => {
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
    /* Anlage 1 gehoert zu den AGB (Leistungsumfang, Preise) und wird nicht
       eigens angenommen — die Mail nennt die bei Annahme geltende Fassung. */
    const anlage1 = legalLinks(config, 'anlage1', config.versions.anlage1);
    documents.push({
      label: ANLAGE1_LABEL,
      version: anlage1.version,
      versionUrl: anlage1.versionUrl,
      pdfUrl: anlage1.pdfUrl,
    });
    return documents;
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
