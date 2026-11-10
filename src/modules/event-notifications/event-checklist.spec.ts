import { buildChecklist, type ChecklistFacts } from './event-checklist';

const APP = 'https://app.example.org';

function facts(overrides: Partial<ChecklistFacts> = {}): ChecklistFacts {
  return {
    appUrl: APP,
    eventId: 'e1',
    eventActive: true,
    shopEnabled: false,
    qrCodes: 0,
    organization: {
      country: 'DE',
      operatingMode: 'cashless',
      operatingModeLegacy: false,
      legalComplete: false,
    },
    posDevices: 2,
    waiterModeDevices: 0,
    waiters: 0,
    printers: { total: 1, online: 1, printedRecently: 1 },
    products: { total: 12, withoutPrice: 0 },
    tse: {
      availability: 'available',
      active: false,
      integrationEnabled: false,
      missingMasterData: [],
    },
    ...overrides,
  };
}

function byId(list: ReturnType<typeof buildChecklist>) {
  return Object.fromEntries(list.map((i) => [i.id, i]));
}

describe('buildChecklist', () => {
  it('alles eingerichtet: nur Haken und ein Tipp zu Bedienungen', () => {
    const list = buildChecklist(facts());
    const items = byId(list);
    expect(items.devices.status).toBe('ok');
    expect(items.devices.detail).toContain('2 Kassen');
    expect(items.printers_online.status).toBe('ok');
    expect(items.test_print.status).toBe('ok');
    expect(items.products.status).toBe('ok');
    expect(items.operating_mode.status).toBe('ok');
    expect(items.operating_mode.detail).toContain('Bargeldlos');
    expect(items.operating_mode.detail).toContain('Deutschland');
    expect(items.waiters.status).toBe('info');
    expect(items.shop_legal).toBeUndefined(); // kein Shop, keine QR-Codes
    expect(items.tse).toBeUndefined(); // bargeldlos braucht keine TSE
    expect(items.event_active).toBeUndefined();
    expect(list.every((i) => i.url.startsWith(APP))).toBe(true);
  });

  it('nichts eingerichtet: offene Punkte mit Direktlinks', () => {
    const items = byId(
      buildChecklist(
        facts({
          eventActive: false,
          posDevices: 0,
          printers: { total: 2, online: 1, printedRecently: 0 },
          products: { total: 0, withoutPrice: 0 },
          shopEnabled: true,
          organization: {
            country: null,
            operatingMode: 'full',
            operatingModeLegacy: false,
            legalComplete: false,
          },
        }),
      ),
    );
    expect(items.event_active.status).toBe('todo');
    expect(items.devices.status).toBe('todo');
    expect(items.devices.url).toBe(`${APP}/devices`);
    expect(items.printers_online.status).toBe('todo');
    expect(items.printers_online.detail).toContain('1 von 2 Druckern');
    expect(items.test_print.status).toBe('todo');
    expect(items.products.status).toBe('todo');
    expect(items.shop_legal.status).toBe('todo');
    expect(items.shop_legal.url).toBe(`${APP}/settings?tab=org-legal`);
    expect(items.operating_mode.status).toBe('todo');
    expect(items.operating_mode.title).toContain('Land');
  });

  it('ohne Drucker: nur ein Hinweis, kein Testdruck-Punkt', () => {
    const items = byId(
      buildChecklist(
        facts({ printers: { total: 0, online: 0, printedRecently: 0 } }),
      ),
    );
    expect(items.printers_online.status).toBe('info');
    expect(items.test_print).toBeUndefined();
  });

  it('Bedienungs-Modus an einer Kasse: Bedienungen und PIN-Zettel', () => {
    expect(
      byId(buildChecklist(facts({ waiterModeDevices: 1 }))).waiters.status,
    ).toBe('todo');
    const ok = byId(
      buildChecklist(facts({ waiterModeDevices: 1, waiters: 6 })),
    ).waiters;
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('PIN-Zettel');
  });

  it('QR-Bestellung zaehlt nur ausserhalb von „Nur Bons“', () => {
    expect(byId(buildChecklist(facts({ qrCodes: 3 }))).shop_legal.status).toBe(
      'todo',
    );
    const ordersOnly = facts({
      qrCodes: 3,
      organization: {
        country: 'DE',
        operatingMode: 'orders_only',
        operatingModeLegacy: false,
        legalComplete: false,
      },
    });
    const items = byId(buildChecklist(ordersOnly));
    expect(items.shop_legal).toBeUndefined();
    expect(items.products.title).toBe('Produkte angelegt');
  });

  it('Rechtliche Angaben vollstaendig: Haken', () => {
    const f = facts({ shopEnabled: true });
    f.organization.legalComplete = true;
    expect(byId(buildChecklist(f)).shop_legal.status).toBe('ok');
  });

  it('Produkte ohne Preis werden erwaehnt (nicht bei „Nur Bons“)', () => {
    const items = byId(
      buildChecklist(facts({ products: { total: 5, withoutPrice: 2 } })),
    );
    expect(items.products.detail).toContain('2 davon haben noch keinen Preis');
  });

  it('Bestand: Betriebsart noch nicht gewaehlt', () => {
    const f = facts();
    f.organization = {
      ...f.organization,
      operatingMode: 'full',
      operatingModeLegacy: true,
    };
    expect(byId(buildChecklist(f)).operating_mode.status).toBe('todo');
    expect(byId(buildChecklist(f)).tse).toBeUndefined();
  });

  describe('Cloud-TSE (DE, „Alle Funktionen“)', () => {
    const full = (tse: Partial<ChecklistFacts['tse']>, country = 'DE') => {
      const f = facts();
      f.organization = { ...f.organization, country, operatingMode: 'full' };
      f.tse = { ...f.tse, ...tse };
      return byId(buildChecklist(f)).tse;
    };

    it('aktiv', () => expect(full({ active: true }).status).toBe('ok'));
    it('bald verfuegbar', () => {
      const item = full({ availability: 'coming_soon' });
      expect(item.status).toBe('info');
      expect(item.title).toContain('bald verfügbar');
    });
    it('nicht eingerichtet', () =>
      expect(full({ availability: 'not_configured' }).status).toBe('todo'));
    it('Integration aus', () =>
      expect(full({}).title).toContain('einschalten'));
    it('Stammdaten fehlen', () => {
      const item = full({
        integrationEnabled: true,
        missingMasterData: ['taxNumber', 'zip'],
      });
      expect(item.status).toBe('todo');
      expect(item.detail).toContain('Steuernummer, PLZ');
    });
    it('vorbereitet: wird vor dem Verkaufsstart eingerichtet', () =>
      expect(full({ integrationEnabled: true }).status).toBe('ok'));
    it('Oesterreich: kein TSE-Punkt', () =>
      expect(full({}, 'AT')).toBeUndefined());
  });
});
