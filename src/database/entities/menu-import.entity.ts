import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Event } from './event.entity';
import { User } from './user.entity';

/**
 * Lebenslauf eines Speisekarten-Imports:
 * queued → processing → done → applied, oder failed. Siehe ki-plan.md 6.3.
 */
export type MenuImportStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'applied';

export type MenuImportSource = 'images' | 'pdf' | 'text';

export interface MenuImportUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Vorschlag, wie ihn die Web-App zur Durchsicht bekommt (Vertrag 6.3). */
export interface MenuSuggestionCategory {
  key: string;
  name: string;
  existingCategoryId?: string;
}

export interface MenuSuggestionVariant {
  name: string;
  priceModifier: number;
}

export interface MenuSuggestionProduct {
  key: string;
  categoryKey: string;
  name: string;
  description?: string;
  price: number;
  taxRate: 0 | 7 | 19;
  pfand?: { suggested: boolean; amount?: number };
  variants?: MenuSuggestionVariant[];
  /** Produkt mit gleichem Namen gibt es in der Veranstaltung schon. */
  existingProductId?: string;
  iconSuggestions?: { icon: string; score: number }[];
  confidence: 'high' | 'medium' | 'low';
  note?: string;
}

export interface MenuSuggestion {
  categories: MenuSuggestionCategory[];
  products: MenuSuggestionProduct[];
  warnings: string[];
}

/**
 * Ein Speisekarten-Import: Dateien (Bilder/PDF) oder Text einer
 * Veranstaltung, der Vorschlag des Modells und was daraus wurde.
 *
 * Dateien liegen nur fuer die Verarbeitung unter
 * `<UPLOAD_DIR>/menu-imports/<id>/` und werden beim Anwenden, Verwerfen
 * oder nach 24 h geloescht (MenuImportWorker). Der Vorschlag selbst
 * bleibt hoechstens 30 Tage.
 */
@Entity('menu_imports')
@Index(['eventId', 'createdAt'])
@Index(['status', 'createdAt'])
export class MenuImport extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status: MenuImportStatus;

  @Column({ type: 'varchar', length: 10 })
  source: MenuImportSource;

  /** Relative Pfade unter dem Upload-Verzeichnis, in Seitenreihenfolge. */
  @Column({ type: 'jsonb', default: [] })
  files: string[];

  /** Eingefuegter Text (nur `source = 'text'`). */
  @Column({ name: 'input_text', type: 'text', nullable: true })
  inputText: string | null;

  @Column({ type: 'jsonb', nullable: true })
  suggestion: MenuSuggestion | null;

  /** Kurzer, verstaendlicher Hinweis fuer die Web-App (bei `failed`). */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  /**
   * Rohmeldung des Anbieters bzw. der Verarbeitung — nur fuer Log und
   * Datenbank, wird nie an Clients ausgeliefert.
   */
  @Column({ name: 'error_detail', type: 'text', nullable: true })
  errorDetail: string | null;

  @Column({ type: 'jsonb', nullable: true })
  usage: MenuImportUsage | null;

  @Column({
    name: 'finished_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  finishedAt: Date | null;

  @Column({
    name: 'applied_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  appliedAt: Date | null;

  /** Reservierung im Kontingent (`ai_usage.id`), wird nach dem Aufruf abgerechnet. */
  @Column({ name: 'usage_id', type: 'uuid', nullable: true })
  usageId: string | null;

  /** Dateien sind geloescht (nach Anwenden/Verwerfen/24 h). */
  @Column({
    name: 'files_deleted_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  filesDeletedAt: Date | null;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event: Event;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;
}
