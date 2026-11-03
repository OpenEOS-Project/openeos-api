import type { CsvRow } from './dsfinvk-format';
import type { TableName } from './dsfinvk-schema';

/**
 * Eingabe des DSFinV-K-Generators (rein, ohne Datenbank). Der
 * Abschluss-Dienst stellt sie aus `tse_transactions`, Organisation, Geraeten
 * und TSEs zusammen; die Tests bauen sie direkt.
 */

export interface DsfinvkAddress {
  street: string;
  zip: string;
  city: string;
  /** ISO 3166 Alpha-3, z. B. `DEU`. */
  country: string;
}

export interface DsfinvkCompany extends DsfinvkAddress {
  name: string;
  taxNumber: string;
  vatId: string;
}

export interface DsfinvkLocation extends DsfinvkAddress {
  name: string;
  vatId: string;
}

export interface DsfinvkRegister {
  /** Z_KASSE_ID = Seriennummer = TSE-Client-ID (`OEOS-…`). */
  id: string;
  brand: string;
  model: string;
  softwareBrand: string;
  softwareVersion: string;
  baseCurrency: string;
}

export interface DsfinvkTerminal {
  id: string;
  brand: string;
  model: string;
  serial: string;
  softwareBrand: string;
  softwareVersion: string;
  /** Anzeigename (nicht Teil der DSFinV-K). */
  name?: string;
}

export interface DsfinvkTseUnit {
  /** interne ID (tse_units.id) */
  id: string;
  serial: string;
  signatureAlgorithm: string;
  logTimeFormat: string;
  publicKey: string;
  certificate: string;
}

export interface DsfinvkVatKey {
  key: number;
  rate: number;
  description: string;
}

/** Stammdaten je Kassenabschluss (DSFinV-K Tz. 3.2: zu jedem Abschluss festzuhalten). */
export interface DsfinvkMasterData {
  company: DsfinvkCompany;
  location: DsfinvkLocation;
  register: DsfinvkRegister;
  terminals: DsfinvkTerminal[];
  tseUnits: DsfinvkTseUnit[];
  vatKeys: DsfinvkVatKey[];
}

export type DsfinvkTxKind =
  | 'receipt'
  | 'refund'
  | 'deposit_return'
  | 'order'
  | 'order_cancellation'
  | 'abort'
  | 'cashbook';

/** Verweis eines Vorgangs auf einen anderen (Bon_Referenzen, REF_TYP Transaktion). */
export interface DsfinvkReference {
  zNr: number;
  /** Z_ERSTELLUNG des Abschlusses, in dem der Ziel-Vorgang steht. */
  closingCreatedAt: Date;
  registerId: string;
  bonId: number;
}

export interface DsfinvkTransaction {
  id: string;
  bonId: number;
  kind: DsfinvkTxKind;
  processType: string;
  processData: string;
  training: boolean;
  status: 'signed' | 'training' | 'failed';
  tseUnitId: string | null;
  transactionNumber: number | null;
  signatureCounter: number | null;
  startTime: Date | null;
  finishTime: Date | null;
  signatureValue: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recovered: boolean;
  /** Beginn des Vorgangs im System (BON_START). */
  createdAt: Date;
  /** Ende des Vorgangs im System (BON_ENDE). */
  endedAt: Date;
  terminal: string | null;
  userId: string | null;
  userName: string | null;
  /** Kopie der Positionen (tse_transactions.lines). */
  lines: Record<string, unknown> | null;
  amountCents: number | null;
  orderId: string | null;
  orderNumber: string | null;
  tableNumber: string | null;
  /** Fuer Erstattungen: Betrag des Ursprungsbelegs (Cent), fuer BON_STORNO. */
  originalAmountCents: number | null;
  references: DsfinvkReference[];
}

export type TipRecipient = 'employer' | 'employee';

export interface DsfinvkSettings {
  /** Steuerbefreit (Kleinunternehmer, Verein ohne USt): alles 0 %. */
  vatExempt: boolean;
  /** Trinkgeld an den Verein (TrinkgeldAG) oder an Helfer (TrinkgeldAN). */
  tipRecipient: TipRecipient;
}

export interface DsfinvkClosingInput {
  zNr: number;
  createdAt: Date;
  /** Geschaeftstag `YYYY-MM-DD` (6–6 Uhr) → Z_BUCHUNGSTAG. */
  businessDate: string;
  master: DsfinvkMasterData;
  settings: DsfinvkSettings;
  transactions: DsfinvkTransaction[];
}

export type DsfinvkRows = Record<TableName, CsvRow[]>;

export interface ClosingTotals {
  /** Summe UMS_BRUTTO aller Belege (BON_TYP Beleg) in Cent — inkl. Kassenbuch, Pfand, Trinkgeld. */
  grossCents: number;
  /** Umsatz brutto (GV Umsatz + Rabatt + Aufschlag) in Cent. */
  salesGrossCents: number;
  /** Summe aller Zahlungen / Barzahlungen (Z_SE_ZAHLUNGEN / Z_SE_BARZAHLUNGEN). */
  paymentsCents: number;
  cashCents: number;
  byBusinessCase: {
    gvTyp: string;
    gvName: string;
    vatKey: number;
    grossCents: number;
    netCents: number;
    vatCents: number;
  }[];
  byPaymentType: { type: string; name: string; cents: number }[];
  byVatKey: {
    vatKey: number;
    grossCents: number;
    netCents: number;
    vatCents: number;
  }[];
  counts: {
    transactions: number;
    receipts: number;
    training: number;
    orders: number;
    failed: number;
    cancelled: number;
  };
  firstBonId: number | null;
  lastBonId: number | null;
}

export interface BuiltClosing {
  rows: DsfinvkRows;
  totals: ClosingTotals;
}
