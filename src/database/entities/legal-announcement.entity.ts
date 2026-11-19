import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { LegalDocumentKey } from '../../config/legal.config';

/**
 * Ankuendigung einer neuen Fassung der Rechtstexte von LUXCODE (AGB,
 * Anlage 1, AVV, Datenschutzerklaerung, Impressum).
 *
 * Die Fassung ist zugleich der Tag des Inkrafttretens (Datum der
 * „Stand“-Zeile, JJJJ-MM-TT). Ab diesem Tag ist sie die aktuelle Fassung
 * der genannten Dokumente (siehe `effectiveLegalVersions`). Bis dahin sehen
 * Admins einen Hinweis in der App; alle Admins bekommen beim Anlegen eine
 * Mail (`legal_announcement_deliveries`).
 *
 * Ankuendigungen sind ein Nachweis gegenueber den Kunden und werden nicht
 * geaendert oder geloescht.
 */
@Entity('legal_announcements')
@Index('IDX_legal_announcements_version', ['version'])
export class LegalAnnouncement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', array: true, length: 10 })
  documents: LegalDocumentKey[];

  /** Neue Fassung = Tag des Inkrafttretens (JJJJ-MM-TT). */
  @Column({ type: 'varchar', length: 10 })
  version: string;

  /** Fassungen beim Ankuendigen (Link „bisherige Fassung“). */
  @Column({ name: 'previous_versions', type: 'jsonb' })
  previousVersions: Partial<Record<LegalDocumentKey, string>>;

  @Column({ name: 'summary_de', type: 'text' })
  summaryDe: string;

  @Column({ name: 'summary_en', type: 'text', nullable: true })
  summaryEn: string | null;

  /**
   * Kuerzere Frist als sechs Wochen fuer AGB/AVV/Anlage 1 — nur bei
   * gesetzlich oder behoerdlich veranlassten Aenderungen.
   */
  @Column({ name: 'short_notice', type: 'boolean', default: false })
  shortNotice: boolean;

  /**
   * Wird nur mit ausdruecklicher Zustimmung wirksam (Hauptleistungen,
   * Verguetung, AVV): keine Zustimmungsfiktion in der Mail, die erneute
   * Annahme in der App laesst sich nicht verschieben.
   */
  @Column({ name: 'explicit_consent', type: 'boolean', default: false })
  explicitConsent: boolean;

  /**
   * Vom AVV aendern sich nur Anhang B (Unterauftragsverarbeiter) bzw.
   * Anhang C (TOM): keine Zustimmung noetig (AVV 12.4), sondern Information
   * vier Wochen vorher mit Widerspruchsrecht (AVV 6.3/6.4).
   */
  @Column({ name: 'avv_annexes_only', type: 'boolean', default: false })
  avvAnnexesOnly: boolean;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ name: 'created_by_email', type: 'varchar', length: 255 })
  createdByEmail: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
