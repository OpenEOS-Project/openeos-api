import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Dokumente, die ein Kunde annimmt (AGB und Auftragsverarbeitungsvertrag). */
export const LEGAL_DOCUMENTS = ['agb', 'avv'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** Wo die Annahme passiert ist. */
export const LEGAL_ACCEPTANCE_CONTEXTS = [
  'registration',
  'reacceptance',
  'purchase',
] as const;
export type LegalAcceptanceContext = (typeof LEGAL_ACCEPTANCE_CONTEXTS)[number];

/**
 * Nachweis, dass ein Benutzer eine bestimmte Fassung der AGB bzw. des
 * Auftragsverarbeitungsvertrags angenommen hat.
 *
 * Die Fassung ist das Datum der „Stand“-Zeile (YYYY-MM-DD); jede Fassung
 * bleibt auf der Website unter `/<dokument>/<fassung>` abrufbar.
 *
 * Die Zeilen sind ein Vertragsnachweis und werden nicht geloescht, solange
 * die Aufbewahrungsfrist laeuft. Deshalb haengen sie nicht hart am Konto:
 * wird ein Benutzer oder eine Organisation geloescht, bleibt die Zeile mit
 * der E-Mail-Adresse und dem Organisationsnamen von damals stehen.
 */
@Entity('legal_acceptances')
@Index('IDX_legal_acceptances_user', ['userId', 'document', 'acceptedAt'])
@Index('IDX_legal_acceptances_org', ['organizationId', 'acceptedAt'])
export class LegalAcceptance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** E-Mail-Adresse beim Annehmen (bleibt, wenn das Konto geloescht wird). */
  @Column({ name: 'user_email', type: 'varchar', length: 255 })
  userEmail: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({
    name: 'organization_name',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  organizationName: string | null;

  @Column({ type: 'varchar', length: 10 })
  document: LegalDocument;

  /** Datum der „Stand“-Zeile der angenommenen Fassung (YYYY-MM-DD). */
  @Column({ type: 'varchar', length: 10 })
  version: string;

  @Column({ type: 'varchar', length: 20 })
  context: LegalAcceptanceContext;

  /**
   * Bei der Registrierung zusaetzlich bestaetigt: Unternehmer, juristische
   * Person des oeffentlichen Rechts oder eingetragener Verein, mit
   * Vertretungsbefugnis (AGB Ziffer 2.4).
   */
  @Column({ name: 'business_confirmed', type: 'boolean', default: false })
  businessConfirmed: boolean;

  @CreateDateColumn({ name: 'accepted_at', type: 'timestamp with time zone' })
  acceptedAt: Date;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;
}
