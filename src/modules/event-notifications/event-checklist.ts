/**
 * Checkliste „Dein Fest rückt näher“ — aus echten Daten der Organisation,
 * jede Zeile mit Stand und Direktlink in die App. Reine Funktion; die
 * Daten sammelt EventNotificationsService.
 *
 * - `ok`: erledigt (✓),
 * - `todo`: fehlt noch (✗),
 * - `info`: Hinweis oder Tipp ohne Pflicht (–), etwa „kein Drucker“ oder
 *   „Cloud-TSE bald verfügbar“.
 */
import type { TseAvailability } from '../tse/tse.config';

export type ChecklistStatus = 'ok' | 'todo' | 'info';

export interface ChecklistItem {
  id:
    | 'event_active'
    | 'devices'
    | 'printers_online'
    | 'test_print'
    | 'waiters'
    | 'products'
    | 'shop_legal'
    | 'operating_mode'
    | 'tse';
  status: ChecklistStatus;
  title: string;
  detail: string;
  url: string;
  linkLabel: string;
}

/** Wie lange ein Testdruck als „kuerzlich“ gilt. */
export const TEST_PRINT_RECENT_DAYS = 14;

export interface ChecklistFacts {
  appUrl: string;
  eventId: string;
  /** Aktiv geschaltet (sonst: gebucht, aber noch im Testmodus). */
  eventActive: boolean;
  /** Shop der Veranstaltung an (`settings.shop.enabled`). */
  shopEnabled: boolean;
  /** Aktive QR-Codes zum Bestellen (Veranstaltung oder organisationsweit). */
  qrCodes: number;
  organization: {
    country: string | null;
    operatingMode: 'orders_only' | 'cashless' | 'full';
    operatingModeLegacy: boolean;
    /** Impressum und Datenschutzhinweis hinterlegt. */
    legalComplete: boolean;
  };
  /** Verbundene Kassen (Typ Kasse, bestaetigt, aktiv). */
  posDevices: number;
  /** Davon mit Bedienungen (gemeinsame oder persoenliche Kasse). */
  waiterModeDevices: number;
  /** Aktive Bedienungen fuer diese Veranstaltung oder organisationsweit. */
  waiters: number;
  printers: {
    total: number;
    online: number;
    /** Testdruck oder erfolgreicher Druck in den letzten 14 Tagen. */
    printedRecently: number;
  };
  products: {
    total: number;
    /** Aktive Produkte mit Preis 0 (nur ausserhalb von „Nur Bons“ erwaehnt). */
    withoutPrice: number;
  };
  tse: {
    availability: TseAvailability;
    active: boolean;
    integrationEnabled: boolean;
    /** Fehlende Stammdaten (`taxNumber`, `street`, `zip`, `city`). */
    missingMasterData: string[];
  };
}

const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Deutschland',
  AT: 'Österreich',
  CH: 'Schweiz',
  LI: 'Liechtenstein',
  LU: 'Luxemburg',
};

const MODE_NAMES: Record<
  ChecklistFacts['organization']['operatingMode'],
  string
> = {
  orders_only: 'Nur Bons',
  cashless: 'Bargeldlos',
  full: 'Alle Funktionen',
};

const MASTER_DATA_NAMES: Record<string, string> = {
  taxNumber: 'Steuernummer',
  street: 'Straße',
  zip: 'PLZ',
  city: 'Ort',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Braucht die Organisation fuer diese Veranstaltung eine Cloud-TSE? */
export function needsCloudTse(
  org: Pick<
    ChecklistFacts['organization'],
    'country' | 'operatingMode' | 'operatingModeLegacy'
  >,
): boolean {
  return (
    (org.country ?? '').toUpperCase() === 'DE' &&
    org.operatingMode === 'full' &&
    !org.operatingModeLegacy
  );
}

export function buildChecklist(facts: ChecklistFacts): ChecklistItem[] {
  const app = facts.appUrl;
  const org = facts.organization;
  const ordersOnly = org.operatingMode === 'orders_only';
  const items: ChecklistItem[] = [];

  if (!facts.eventActive) {
    items.push({
      id: 'event_active',
      status: 'todo',
      title: 'Veranstaltung aktivieren',
      detail:
        'Die Veranstaltung ist gebucht, aber noch nicht aktiv. Aktiviere sie, damit die Kassen sie anzeigen.',
      url: `${app}/events`,
      linkLabel: 'Veranstaltungen',
    });
  }

  items.push(
    facts.posDevices > 0
      ? {
          id: 'devices',
          status: 'ok',
          title: 'Kassen verbunden',
          detail: `${plural(facts.posDevices, 'Kasse', 'Kassen')} mit deiner Organisation verbunden.`,
          url: `${app}/devices`,
          linkLabel: 'Geräte',
        }
      : {
          id: 'devices',
          status: 'todo',
          title: 'Kasse verbinden',
          detail:
            'Noch ist keine Kasse verbunden. Öffne OpenEOS auf einem Tablet oder Smartphone und verbinde es als Kasse.',
          url: `${app}/devices`,
          linkLabel: 'Geräte',
        },
  );

  if (facts.printers.total === 0) {
    items.push({
      id: 'printers_online',
      status: 'info',
      title: 'Kein Drucker eingerichtet',
      detail:
        'Nur nötig, wenn du Bons oder Küchenzettel drucken willst. Dafür läuft der Drucker-Agent auf einem Rechner oder Raspberry Pi am Fest.',
      url: `${app}/printers`,
      linkLabel: 'Drucker',
    });
  } else {
    const { total, online, printedRecently } = facts.printers;
    items.push(
      online >= total
        ? {
            id: 'printers_online',
            status: 'ok',
            title: 'Drucker online',
            detail:
              total === 1
                ? 'Dein Drucker ist gerade erreichbar.'
                : `Alle ${total} Drucker sind gerade erreichbar.`,
            url: `${app}/printers`,
            linkLabel: 'Drucker',
          }
        : {
            id: 'printers_online',
            status: 'todo',
            title: 'Drucker prüfen',
            detail: `${online} von ${plural(total, 'Drucker', 'Druckern')} gerade online. Schalte Drucker und Drucker-Agent ein und sieh nach, ob sie in OpenEOS als online erscheinen.`,
            url: `${app}/printers`,
            linkLabel: 'Drucker',
          },
    );
    items.push(
      printedRecently > 0
        ? {
            id: 'test_print',
            status: 'ok',
            title: 'Testdruck gemacht',
            detail: `In den letzten ${TEST_PRINT_RECENT_DAYS} Tagen hat ${printedRecently === 1 ? 'ein Drucker' : `${printedRecently} Drucker`} gedruckt.`,
            url: `${app}/printers`,
            linkLabel: 'Drucker',
          }
        : {
            id: 'test_print',
            status: 'todo',
            title: 'Testdruck machen',
            detail:
              'Schick einmal einen Testdruck an jeden Drucker, damit am Festtag nichts überrascht.',
            url: `${app}/printers`,
            linkLabel: 'Drucker',
          },
    );
  }

  if (facts.waiterModeDevices > 0) {
    items.push(
      facts.waiters > 0
        ? {
            id: 'waiters',
            status: 'ok',
            title: 'Bedienungen angelegt',
            detail: `${plural(facts.waiters, 'Bedienung', 'Bedienungen')} angelegt. Denk an die PIN-Zettel – du druckst sie unter „Bedienungen“.`,
            url: `${app}/waiters`,
            linkLabel: 'Bedienungen',
          }
        : {
            id: 'waiters',
            status: 'todo',
            title: 'Bedienungen anlegen',
            detail: `${plural(facts.waiterModeDevices, 'Kasse arbeitet', 'Kassen arbeiten')} mit Bedienungen, aber es gibt noch keine. Leg sie mit einer Namensliste an und druck die PIN-Zettel.`,
            url: `${app}/waiters`,
            linkLabel: 'Bedienungen',
          },
    );
  } else {
    items.push({
      id: 'waiters',
      status: 'info',
      title: 'Tipp: Bedienungen mit PIN',
      detail:
        'Mit Bedienungen meldet sich jede Helferin und jeder Helfer per PIN an der Kasse an. Jede Buchung zeigt dann, wer kassiert hat, und am Ende rechnest du je Person ab.',
      url: `${app}/waiters`,
      linkLabel: 'Bedienungen',
    });
  }

  if (facts.products.total > 0) {
    const free =
      !ordersOnly && facts.products.withoutPrice > 0
        ? ` ${facts.products.withoutPrice === 1 ? 'Eines hat' : `${facts.products.withoutPrice} davon haben`} noch keinen Preis.`
        : '';
    items.push({
      id: 'products',
      status: 'ok',
      title: ordersOnly ? 'Produkte angelegt' : 'Produkte und Preise angelegt',
      detail: `${plural(facts.products.total, 'Produkt', 'Produkte')} in dieser Veranstaltung.${free}`,
      url: `${app}/products`,
      linkLabel: 'Produkte',
    });
  } else {
    items.push({
      id: 'products',
      status: 'todo',
      title: 'Produkte anlegen',
      detail:
        'Die Veranstaltung hat noch keine Produkte. Leg deine Speisen und Getränke an oder übernimm sie aus einer früheren Veranstaltung.',
      url: `${app}/products`,
      linkLabel: 'Produkte',
    });
  }

  const qrOrdering = !ordersOnly && facts.qrCodes > 0;
  if (facts.shopEnabled || qrOrdering) {
    const what =
      facts.shopEnabled && qrOrdering
        ? 'Shop und QR-Bestellung'
        : facts.shopEnabled
          ? 'Dein Shop'
          : 'Die Bestellung per QR-Code';
    items.push(
      org.legalComplete
        ? {
            id: 'shop_legal',
            status: 'ok',
            title: 'Impressum und Datenschutzhinweis',
            detail:
              'Beides ist hinterlegt und erscheint im Shop und bei der QR-Bestellung.',
            url: `${app}/settings?tab=org-legal`,
            linkLabel: 'Rechtliche Angaben',
          }
        : {
            id: 'shop_legal',
            status: 'todo',
            title: 'Impressum und Datenschutzhinweis eintragen',
            detail: `${what} nimmt erst Bestellungen an, wenn Impressum und Datenschutzhinweis deines Vereins hinterlegt sind.`,
            url: `${app}/settings?tab=org-legal`,
            linkLabel: 'Rechtliche Angaben',
          },
    );
  }

  const country = (org.country ?? '').toUpperCase();
  if (!country) {
    items.push({
      id: 'operating_mode',
      status: 'todo',
      title: 'Land und Betriebsart festlegen',
      detail:
        'Für deine Organisation ist noch kein Land hinterlegt. Davon hängt ab, welche Zahlungsarten an der Kasse gehen.',
      url: `${app}/settings?tab=org-mode`,
      linkLabel: 'Betriebsart',
    });
  } else if (org.operatingModeLegacy) {
    items.push({
      id: 'operating_mode',
      status: 'todo',
      title: 'Betriebsart wählen',
      detail:
        'Deine Organisation läuft noch als „Alle Funktionen (Bestand)“. Wähle „Nur Bons“, „Bargeldlos“ oder „Alle Funktionen“.',
      url: `${app}/settings?tab=org-mode`,
      linkLabel: 'Betriebsart',
    });
  } else {
    items.push({
      id: 'operating_mode',
      status: 'ok',
      title: 'Betriebsart gewählt',
      detail: `„${MODE_NAMES[org.operatingMode]}“, Land: ${COUNTRY_NAMES[country] ?? country}.`,
      url: `${app}/settings?tab=org-mode`,
      linkLabel: 'Betriebsart',
    });
  }

  const tse = tseItem(facts);
  if (tse) items.push(tse);

  return items;
}

function tseItem(facts: ChecklistFacts): ChecklistItem | null {
  const app = facts.appUrl;
  const t = facts.tse;
  if (!needsCloudTse(facts.organization) && !t.active) return null;
  const url = `${app}/integrations/tse`;
  if (t.active) {
    return {
      id: 'tse',
      status: 'ok',
      title: 'Cloud-TSE aktiv',
      detail: 'Bargeld ist freigegeben; jeder Bon wird signiert.',
      url,
      linkLabel: 'Cloud-TSE',
    };
  }
  if (t.availability === 'coming_soon') {
    return {
      id: 'tse',
      status: 'info',
      title: 'Cloud-TSE: bald verfügbar',
      detail:
        'Bargeld geht in Deutschland nur mit TSE. Bis die Cloud-TSE da ist, kassierst du mit Karte oder online – oder nutzt „Nur Bons“.',
      url: `${app}/settings?tab=org-mode`,
      linkLabel: 'Betriebsart',
    };
  }
  if (t.availability === 'not_configured') {
    return {
      id: 'tse',
      status: 'todo',
      title: 'Keine Cloud-TSE',
      detail:
        'Auf diesem Server ist keine Cloud-TSE eingerichtet, Bargeld bleibt gesperrt. Wähle „Bargeldlos“ oder „Nur Bons“.',
      url: `${app}/settings?tab=org-mode`,
      linkLabel: 'Betriebsart',
    };
  }
  if (!t.integrationEnabled) {
    return {
      id: 'tse',
      status: 'todo',
      title: 'Cloud-TSE einschalten',
      detail:
        'Für Bargeld brauchst du die Cloud-TSE. Schalte sie ein, dann richtet OpenEOS sie vor dem Verkaufsstart selbst ein.',
      url,
      linkLabel: 'Cloud-TSE',
    };
  }
  if (t.missingMasterData.length > 0) {
    const names = t.missingMasterData
      .map((key) => MASTER_DATA_NAMES[key] ?? key)
      .join(', ');
    return {
      id: 'tse',
      status: 'todo',
      title: 'Stammdaten für die Cloud-TSE ergänzen',
      detail: `Es fehlt noch: ${names}. Ohne diese Angaben kann OpenEOS die TSE nicht einrichten.`,
      url,
      linkLabel: 'Cloud-TSE',
    };
  }
  return {
    id: 'tse',
    status: 'ok',
    title: 'Cloud-TSE vorbereitet',
    detail:
      'OpenEOS richtet die TSE automatisch 12 Stunden vor dem Verkaufsstart ein.',
    url,
    linkLabel: 'Cloud-TSE',
  };
}
