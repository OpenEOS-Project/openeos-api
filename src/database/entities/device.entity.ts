import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Organization } from './organization.entity';
import { Order } from './order.entity';
import { Payment } from './payment.entity';
import { Printer } from './printer.entity';
import { User } from './user.entity';

export enum DeviceType {
  POS = 'pos',
  DISPLAY = 'display',
  ADMIN = 'admin',
  PRINTER_AGENT = 'printer_agent',
}

export enum DeviceStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  BLOCKED = 'blocked',
}

export type ServiceMode = 'table' | 'counter';
export type PrinterMode =
  | 'fixed'
  | 'dynamic'
  | 'device'
  | 'category'
  | 'product';
export type DisplayMode = 'customer' | 'station';
export const TABLE_SELECT_VIEWS = ['number', 'list', 'map'] as const;
export type TableSelectView = (typeof TABLE_SELECT_VIEWS)[number];

/**
 * Aussehen und Inhalt einer Anzeige.
 *
 * Liegt im JSON der Geraeteeinstellungen, nicht in eigenen Spalten: die
 * Liste wird wachsen, und jede neue Stellschraube waere sonst eine
 * Migration. Alles ist optional — fehlt ein Wert, gilt die Vorgabe der
 * Anzeige selbst.
 */
export interface DisplayAppearance {
  /** Farbgebung. 'auto' folgt der Tageszeit des Geraets. */
  theme?: 'dark' | 'light' | 'auto';
  /** Groessere Schrift fuer Bildschirme, die weiter weg haengen. */
  scale?: 'normal' | 'large';
  /** Eigene Kopfzeile statt des Organisationsnamens. */
  headline?: string;
  showLogo?: boolean;
  /** Text, solange nichts anzuzeigen ist — statt einer leeren Flaeche. */
  idleText?: string;
  /**
   * Stationsanzeige: erledigte Bestellungen nach so vielen Sekunden
   * ausblenden. 0 heisst: stehen lassen, bis jemand sie wegnimmt.
   */
  autoClearSeconds?: number;
}

/**
 * „Stornieren & Erstatten“ an der Kasse: `allowed` (Standard), `pin` (nur
 * nach PIN eines Mitglieds mit Recht „Bestellungen“ oder Admin),
 * `disabled`.
 */
export const REFUND_PERMISSIONS = ['allowed', 'pin', 'disabled'] as const;
export type RefundPermissionSetting = (typeof REFUND_PERMISSIONS)[number];

/**
 * Was ein Drucker-Agent ueber sich meldet (`agentHeartbeat`). Nur bei
 * `type = printer_agent` gesetzt.
 */
export interface PrinterAgentInfo {
  version?: string;
  /** 'linux' | 'windows' | 'darwin' — offen fuer weitere Plattformen. */
  os?: string;
  arch?: string;
  hostname?: string;
  pythonVersion?: string;
  capabilities?: {
    usb?: boolean;
    mdns?: boolean;
    portscan?: boolean;
    spooler?: boolean;
  };
}

export interface DeviceSettings {
  defaultPrinterId?: string;
  soundEnabled?: boolean;
  autoLogout?: number;
  sumupReaderId?: string;
  serviceMode?: ServiceMode;
  printerMode?: PrinterMode;
  requirePin?: boolean;
  displayMode?: DisplayMode;
  /** Standardbereich der Kasse (Tischwahl oeffnet diesen Bereich zuerst). */
  tableAreaId?: string;
  /**
   * Tischwahl an der Kasse: Ziffernblock (`number`), Liste nach Bereichen
   * (`list`) oder Tischplan (`map`). Fest je Geraet — die Kasse schaltet
   * nicht mehr selbst um. Fehlt der Wert, waehlt die Kasse: `map`, wenn der
   * Standardbereich (`tableAreaId`) einen Tischplan hat (Tische mit Lage
   * auf der Karte), sonst `list` bei vordefinierten Tischen. Bei
   * freier Tischnummer (Event `tables.mode = free`) gilt immer der
   * Ziffernblock.
   */
  tableSelectView?: TableSelectView;
  /** Stornieren & Erstatten an dieser Kasse (fehlt = `allowed`). */
  refundPermission?: RefundPermissionSetting | null;
  /** For customer displays: the POS device whose live cart is mirrored */
  posDeviceId?: string;
  /** Aussehen und Inhalt — nur bei Anzeigen ausgewertet. */
  display?: DisplayAppearance;
  /**
   * Bedienungen (bedienungen-plan.md §4): `off` = ohne PIN (wie bisher),
   * `shared` = gemeinsame Kasse, vor dem Buchen meldet sich eine Bedienung
   * per PIN an, `personal` = feste Bedienung (`waiterId`). Fehlt der Wert,
   * gilt `requirePin: true` als `shared`.
   */
  waiterMode?: 'off' | 'shared' | 'personal';
  /** Feste Bedienung bei `waiterMode = personal`. */
  waiterId?: string | null;
  /** Automatische Sperre nach so vielen Sekunden ohne Beruehrung (0/fehlt = aus). */
  autoLockSeconds?: number | null;
  /** Nach jedem Kassieren sperren (Theke). */
  lockAfterPayment?: boolean;
  /** Namenskacheln (Kurzname + Farbe) auf dem Sperrbildschirm (Standard aus). */
  waiterTiles?: boolean;
  /**
   * PIN-Eingabe nach zu vielen Fehlversuchen gesperrt (ISO-Zeit), bis ein
   * Admin sie freigibt.
   */
  waiterPinLockedAt?: string | null;
  [key: string]: unknown;
}

@Entity('devices')
@Index(['organizationId'])
export class Device extends BaseEntity {
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({
    name: 'suggested_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  suggestedName: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: DeviceType, enumName: 'device_type' })
  type: DeviceType;

  @Column({ name: 'device_token', type: 'varchar', length: 255, unique: true })
  deviceToken: string;

  @Column({
    name: 'last_seen_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  lastSeenAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({
    type: 'enum',
    enum: DeviceStatus,
    enumName: 'device_status',
    default: DeviceStatus.PENDING,
  })
  status: DeviceStatus;

  @Column({
    name: 'verification_code',
    type: 'varchar',
    length: 8,
    nullable: true,
  })
  verificationCode: string | null;

  /** Bis wann der Kopplungscode gilt (pairing-code.ts). */
  @Column({
    name: 'verification_code_expires_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  verificationCodeExpiresAt: Date | null;

  /**
   * Hash der IP-Adresse, von der sich ein wartendes Geraet angemeldet hat —
   * nur fuer die Obergrenze wartender Geraete je Adresse. Wird beim
   * Koppeln geleert.
   */
  @Column({
    name: 'pairing_ip_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
    select: false,
  })
  pairingIpHash: string | null;

  @Column({
    name: 'verified_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by_id', type: 'uuid', nullable: true })
  verifiedById: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'jsonb', default: {} })
  settings: DeviceSettings;

  /** Nur Drucker-Agenten: Version, Betriebssystem, Faehigkeiten. */
  @Column({ name: 'agent_info', type: 'jsonb', nullable: true })
  agentInfo: PrinterAgentInfo | null;

  // Relations
  @ManyToOne(() => Organization, (org) => org.devices, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'verified_by_id' })
  verifiedBy: User | null;

  @OneToMany(() => Order, (order) => order.createdByDevice)
  createdOrders: Order[];

  @OneToMany(() => Payment, (payment) => payment.processedByDevice)
  processedPayments: Payment[];

  @OneToMany(() => Printer, (printer) => printer.device)
  printers: Printer[];

  // Helper methods
  isOnline(): boolean {
    if (!this.lastSeenAt) return false;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.lastSeenAt > fiveMinutesAgo;
  }
}
