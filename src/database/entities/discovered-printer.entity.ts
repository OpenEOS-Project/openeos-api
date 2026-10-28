import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Device } from './device.entity';
import { Organization } from './organization.entity';
import { Printer, PrinterConnectionType } from './printer.entity';

export const DISCOVERED_VIA = [
  'usb',
  'mdns',
  'portscan',
  'spooler',
  'manual',
] as const;
export type DiscoveredVia = (typeof DISCOVERED_VIA)[number];

/** Ergebnis der ESC/POS-Modellabfrage (`GS I`) des Agents. */
export const DISCOVERED_ESCPOS = ['yes', 'no', 'unknown'] as const;
export type DiscoveredEscpos = (typeof DISCOVERED_ESCPOS)[number];

/** Einschaetzung des Agents, um was fuer ein Geraet es sich handelt. */
export const DISCOVERED_KIND = [
  'receipt',
  'label',
  'office',
  'unknown',
] as const;
export type DiscoveredKind = (typeof DISCOVERED_KIND)[number];

/** Was der Agent ueber einen gefundenen Drucker weiss — alles optional. */
export interface DiscoveredPrinterDetails {
  manufacturer?: string;
  product?: string;
  model?: string;
  serialNumber?: string;
  usbVendorId?: string;
  usbProductId?: string;
  ipAddress?: string;
  port?: number;
  hostname?: string;
  macAddress?: string;
  windowsPrinterName?: string;
  driverName?: string;
  /** Antwortet das Geraet auf die ESC/POS-Modellabfrage? */
  escpos?: DiscoveredEscpos;
  /** Bondrucker, Etikettendrucker, Buerodrucker oder unbekannt. */
  kind?: DiscoveredKind;
  /** Kurze Begruendung fuer `kind`, z. B. "Hersteller-ID Epson". */
  kindReason?: string;
  [key: string]: unknown;
}

/**
 * Ein Drucker, den ein Drucker-Agent gefunden hat. Noch nicht nutzbar:
 * erst nach dem Uebernehmen in der Web-App entsteht eine `printers`-Zeile
 * (`printerId`). Eindeutig je Agent ueber den Fingerprint.
 */
@Entity('discovered_printers')
@Unique('UQ_discovered_printers_device_fingerprint', [
  'deviceId',
  'fingerprint',
])
@Index(['organizationId'])
@Index(['printerId'])
export class DiscoveredPrinter extends BaseEntity {
  @Column({ name: 'device_id', type: 'uuid' })
  deviceId: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 255 })
  fingerprint: string;

  @Column({
    name: 'connection_type',
    type: 'enum',
    enum: PrinterConnectionType,
    enumName: 'printer_connection_type',
  })
  connectionType: PrinterConnectionType;

  @Column({ name: 'display_name', type: 'varchar', length: 255 })
  displayName: string;

  @Column({ type: 'jsonb', default: {} })
  details: DiscoveredPrinterDetails;

  @Column({ name: 'discovered_via', type: 'varchar', length: 20 })
  discoveredVia: DiscoveredVia;

  @Column({ name: 'first_seen_at', type: 'timestamp with time zone' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamp with time zone' })
  lastSeenAt: Date;

  /** Gesetzt, sobald der Drucker uebernommen wurde. */
  @Column({ name: 'printer_id', type: 'uuid', nullable: true })
  printerId: string | null;

  // Relations
  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: Device;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  @ManyToOne(() => Printer, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'printer_id' })
  printer: Printer | null;
}
