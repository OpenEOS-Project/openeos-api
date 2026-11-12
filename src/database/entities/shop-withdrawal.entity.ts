import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Widerruf einer Shop-Bestellung ueber die elektronische Widerrufsfunktion
 * (§ 356a BGB). Nur fuer Vereine, die in den rechtlichen Angaben
 * „Für Bestellungen besteht ein Widerrufsrecht“ eingeschaltet haben.
 *
 * Der Datensatz belegt Inhalt und Zeitpunkt des Eingangs; der Verein
 * bekommt den Widerruf per E-Mail, der Gast sofort eine Eingangsbestaetigung.
 * Geloescht wird `RETENTION_WITHDRAWAL_MONTHS` (36) Monate nach dem Eingang.
 */
@Entity('shop_withdrawals')
@Index(['organizationId', 'receivedAt'])
@Index(['eventId'])
export class ShopWithdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Eingangszeitpunkt — steht so in der Bestaetigung. */
  @CreateDateColumn({ name: 'received_at', type: 'timestamp with time zone' })
  receivedAt: Date;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;

  /** Gefundene Bestellung (Nummer und E-Mail passen); sonst leer. */
  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  /** Bestellnummer wie angegeben. */
  @Column({ name: 'order_reference', type: 'varchar', length: 100 })
  orderReference: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({
    name: 'club_notified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  clubNotifiedAt: Date | null;

  @Column({
    name: 'confirmation_sent_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  confirmationSentAt: Date | null;
}
