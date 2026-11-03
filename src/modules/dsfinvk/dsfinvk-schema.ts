/**
 * Tabellen der DSFinV-K 2.4 (BZSt, Stand 15.12.2023) genau wie in der
 * amtlichen `index.xml` (assets/dsfinvk/index.xml): Dateiname, Tabellenname,
 * Spalten in Reihenfolge, Typ, Laenge bzw. Nachkommastellen.
 *
 * Generiert aus der vendorten index.xml; `dsfinvk-schema.spec.ts` prueft,
 * dass beide uebereinstimmen. Nicht von Hand aendern, ohne die index.xml
 * mitzupruefen.
 */

export type ColumnType = 'alpha' | 'numeric';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** Hoechstlaenge (nur `alpha`). */
  maxLength?: number;
  /** Nachkommastellen (nur `numeric`, 0 = ganze Zahl). */
  accuracy?: number;
}

export interface TableDef {
  /** Dateiname im Export, z. B. `transactions.csv`. */
  file: string;
  /** Tabellenname laut index.xml, z. B. `Bonkopf`. */
  name: string;
  columns: ColumnDef[];
}

const a = (name: string, maxLength: number): ColumnDef => ({
  name,
  type: 'alpha',
  maxLength,
});
const n = (name: string, accuracy = 0): ColumnDef => ({
  name,
  type: 'numeric',
  accuracy,
});

export const DSFINVK_TABLES = [
  {
    file: 'cashpointclosing.csv',
    name: 'Stamm_Abschluss',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('Z_BUCHUNGSTAG', 25),
      a('TAXONOMIE_VERSION', 10),
      a('Z_START_ID', 40),
      a('Z_ENDE_ID', 40),
      a('NAME', 60),
      a('STRASSE', 60),
      a('PLZ', 10),
      a('ORT', 62),
      a('LAND', 3),
      a('STNR', 20),
      a('USTID', 15),
      n('Z_SE_ZAHLUNGEN', 2),
      n('Z_SE_BARZAHLUNGEN', 2),
    ],
  },
  {
    file: 'location.csv',
    name: 'Stamm_Orte',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('LOC_NAME', 60),
      a('LOC_STRASSE', 60),
      a('LOC_PLZ', 10),
      a('LOC_ORT', 62),
      a('LOC_LAND', 3),
      a('LOC_USTID', 15),
    ],
  },
  {
    file: 'cashregister.csv',
    name: 'Stamm_Kassen',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('KASSE_BRAND', 50),
      a('KASSE_MODELL', 50),
      a('KASSE_SERIENNR', 70),
      a('KASSE_SW_BRAND', 50),
      a('KASSE_SW_VERSION', 50),
      a('KASSE_BASISWAEH_CODE', 3),
      a('KEINE_UST_ZUORDNUNG', 1),
    ],
  },
  {
    file: 'slaves.csv',
    name: 'Stamm_Terminals',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('TERMINAL_ID', 50),
      a('TERMINAL_BRAND', 50),
      a('TERMINAL_MODELL', 50),
      a('TERMINAL_SERIENNR', 70),
      a('TERMINAL_SW_BRAND', 50),
      a('TERMINAL_SW_VERSION', 50),
    ],
  },
  {
    file: 'pa.csv',
    name: 'Stamm_Agenturen',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      n('AGENTUR_ID'),
      a('AGENTUR_NAME', 60),
      a('AGENTUR_STRASSE', 60),
      a('AGENTUR_PLZ', 10),
      a('AGENTUR_ORT', 62),
      a('AGENTUR_LAND', 3),
      a('AGENTUR_STNR', 20),
      a('AGENTUR_USTID', 15),
    ],
  },
  {
    file: 'tse.csv',
    name: 'Stamm_TSE',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      n('TSE_ID'),
      a('TSE_SERIAL', 68),
      a('TSE_SIG_ALGO', 21),
      a('TSE_ZEITFORMAT', 31),
      a('TSE_PD_ENCODING', 5),
      a('TSE_PUBLIC_KEY', 512),
      a('TSE_ZERTIFIKAT_I', 1000),
      a('TSE_ZERTIFIKAT_II', 1000),
    ],
  },
  {
    file: 'vat.csv',
    name: 'Stamm_USt',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      n('UST_SCHLUESSEL'),
      n('UST_SATZ', 2),
      a('UST_BESCHR', 55),
    ],
  },
  {
    file: 'businesscases.csv',
    name: 'Z_GV_Typ',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('GV_TYP', 30),
      a('GV_NAME', 40),
      n('AGENTUR_ID'),
      n('UST_SCHLUESSEL'),
      n('Z_UMS_BRUTTO', 5),
      n('Z_UMS_NETTO', 5),
      n('Z_UST', 5),
    ],
  },
  {
    file: 'payment.csv',
    name: 'Z_Zahlart',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('ZAHLART_TYP', 25),
      a('ZAHLART_NAME', 60),
      n('Z_ZAHLART_BETRAG', 2),
    ],
  },
  {
    file: 'cash_per_currency.csv',
    name: 'Z_Waehrungen',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('ZAHLART_WAEH', 3),
      n('ZAHLART_BETRAG_WAEH', 2),
    ],
  },
  {
    file: 'transactions.csv',
    name: 'Bonkopf',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      n('BON_NR'),
      a('BON_TYP', 30),
      a('BON_NAME', 60),
      a('TERMINAL_ID', 50),
      a('BON_STORNO', 1),
      a('BON_START', 30),
      a('BON_ENDE', 30),
      a('BEDIENER_ID', 50),
      a('BEDIENER_NAME', 50),
      n('UMS_BRUTTO', 2),
      a('KUNDE_NAME', 50),
      a('KUNDE_ID', 50),
      a('KUNDE_TYP', 50),
      a('KUNDE_STRASSE', 60),
      a('KUNDE_PLZ', 10),
      a('KUNDE_ORT', 62),
      a('KUNDE_LAND', 3),
      a('KUNDE_USTID', 15),
      a('BON_NOTIZ', 255),
    ],
  },
  {
    file: 'datapayment.csv',
    name: 'Bonkopf_Zahlarten',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('ZAHLART_TYP', 25),
      a('ZAHLART_NAME', 60),
      a('ZAHLWAEH_CODE', 3),
      n('ZAHLWAEH_BETRAG', 2),
      n('BASISWAEH_BETRAG', 2),
    ],
  },
  {
    file: 'lines.csv',
    name: 'Bonpos',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('POS_ZEILE', 50),
      a('GUTSCHEIN_NR', 50),
      a('ARTIKELTEXT', 255),
      a('POS_TERMINAL_ID', 50),
      a('GV_TYP', 30),
      a('GV_NAME', 40),
      a('INHAUS', 1),
      a('P_STORNO', 1),
      n('AGENTUR_ID'),
      a('ART_NR', 50),
      a('GTIN', 50),
      a('WARENGR_ID', 40),
      a('WARENGR', 50),
      n('MENGE', 3),
      n('FAKTOR', 3),
      a('EINHEIT', 50),
      n('STK_BR', 5),
    ],
  },
  {
    file: 'itemamounts.csv',
    name: 'Bonpos_Preisfindung',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('POS_ZEILE', 50),
      a('TYP', 20),
      n('UST_SCHLUESSEL'),
      n('PF_BRUTTO', 5),
      n('PF_NETTO', 5),
      n('PF_UST', 5),
    ],
  },
  {
    file: 'subitems.csv',
    name: 'Bonpos_Zusatzinfo',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('POS_ZEILE', 50),
      a('ZI_ART_NR', 50),
      a('ZI_GTIN', 50),
      a('ZI_NAME', 60),
      a('ZI_WARENGR_ID', 40),
      a('ZI_WARENGR', 50),
      n('ZI_MENGE', 3),
      n('ZI_FAKTOR', 3),
      a('ZI_EINHEIT', 50),
      n('ZI_UST_SCHLUESSEL'),
      n('ZI_BASISPREIS_BRUTTO', 5),
      n('ZI_BASISPREIS_NETTO', 5),
      n('ZI_BASISPREIS_UST', 5),
    ],
  },
  {
    file: 'transactions_tse.csv',
    name: 'TSE_Transaktionen',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      n('TSE_ID'),
      n('TSE_TANR'),
      a('TSE_TA_START', 30),
      a('TSE_TA_ENDE', 30),
      a('TSE_TA_VORGANGSART', 30),
      n('TSE_TA_SIGZ'),
      a('TSE_TA_SIG', 512),
      a('TSE_TA_FEHLER', 200),
      a('TSE_VORGANGSDATEN', 1000),
    ],
  },
  {
    file: 'transactions_vat.csv',
    name: 'Bonkopf_USt',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      n('UST_SCHLUESSEL'),
      n('BON_BRUTTO', 5),
      n('BON_NETTO', 5),
      n('BON_UST', 5),
    ],
  },
  {
    file: 'lines_vat.csv',
    name: 'Bonpos_USt',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('POS_ZEILE', 50),
      n('UST_SCHLUESSEL'),
      n('POS_BRUTTO', 5),
      n('POS_NETTO', 5),
      n('POS_UST', 5),
    ],
  },
  {
    file: 'allocation_groups.csv',
    name: 'Bonkopf_AbrKreis',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('ABRECHNUNGSKREIS', 50),
    ],
  },
  {
    file: 'references.csv',
    name: 'Bon_Referenzen',
    columns: [
      a('Z_KASSE_ID', 50),
      a('Z_ERSTELLUNG', 30),
      n('Z_NR'),
      a('BON_ID', 40),
      a('POS_ZEILE', 50),
      a('REF_TYP', 20),
      a('REF_NAME', 40),
      a('REF_DATUM', 30),
      a('REF_Z_KASSE_ID', 50),
      n('REF_Z_NR'),
      a('REF_BON_ID', 40),
    ],
  },
] as const satisfies readonly TableDef[];

export type TableName = (typeof DSFINVK_TABLES)[number]['name'];

export const TABLE_BY_NAME: Record<TableName, TableDef> = Object.fromEntries(
  DSFINVK_TABLES.map((t) => [t.name, t]),
) as unknown as Record<TableName, TableDef>;

export const TABLE_NAMES = DSFINVK_TABLES.map((t) => t.name);

/** Version der DSFinV-K, nach der exportiert wird (Feld TAXONOMIE_VERSION). */
export const DSFINVK_VERSION = '2.4';
