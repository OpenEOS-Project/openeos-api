import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type ContactRequestKind =
  | 'demo'
  | 'contact'
  | 'hardware'
  | 'gateway'
  | 'feedback'
  | 'feature';

/**
 * Was uns über die Website erreicht: Anfragen, Rueckmeldungen, Wuensche.
 *
 * Bis hierher wurden diese Nachrichten nur weitergeleitet und nirgends
 * abgelegt. Solange eine Mail ankommt, faellt das nicht auf — ist keine
 * Empfaengeradresse gesetzt oder streikt der Mailserver, war die
 * Zuschrift weg, waehrend der Absender eine Bestaetigung las.
 *
 * Fuer Funktionswuensche kommt hinzu, dass man sie spaeter wieder
 * durchsehen will. Ein Postfach ist dafuer der falsche Ort.
 */
@Entity('contact_requests')
@Index(['type'])
@Index(['createdAt'])
export class ContactRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @Column({ type: 'varchar', length: 20 })
  type: ContactRequestKind;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  organization: string | null;

  @Column({ type: 'text' })
  message: string;

  /** Ob die Benachrichtigung rausging — sonst bleibt unklar, ob jemand sie gesehen hat. */
  @Column({ name: 'notified_at', type: 'timestamp with time zone', nullable: true })
  notifiedAt: Date | null;

  /** Erledigt-Haken fuer die Durchsicht. */
  @Column({ name: 'handled_at', type: 'timestamp with time zone', nullable: true })
  handledAt: Date | null;
}
