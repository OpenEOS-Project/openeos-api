import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { AdminAction } from '../../../database/entities/admin-audit-log.entity';
import { Organization } from '../../../database/entities/organization.entity';
import { OrganizationOperatingModeChange } from '../../../database/entities/organization-operating-mode-change.entity';
import { User } from '../../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../../database/entities/user-organization.entity';
import { SuperAdminGuard } from '../../../common/guards/super-admin.guard';
import { SAAS_ONLY_KEY } from '../../../common/decorators/saas-only.decorator';
import { tseStatus } from '../../../common/utils/tse.util';
import { AdminController } from '../../admin/admin.controller';
import { AdminService } from '../../admin/admin.service';
import { OrganizationsController } from '../organizations.controller';
import { OrganizationsService } from '../organizations.service';
import {
  buildCertificateContent,
  operatorFromEnv,
  renderCertificatePdf,
} from './operating-mode-certificate';
import { OperatingModeService } from './operating-mode.service';

/**
 * Betriebsart wechseln (Verein und Support), Verlauf, Protokoll und
 * Herstellerbescheinigung (betriebsarten-spec.md §2–§4).
 */

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '2a3f1c52-4f43-4a3e-9f8e-0f2b8f3f1a77';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  tseStatus.isActive = () => false;
});

const superAdmin = {
  id: 'support-1',
  firstName: 'Sam',
  lastName: 'Support',
  email: 'support@openeos.example',
  isSuperAdmin: true,
} as User;

const clubAdmin = {
  id: 'user-1',
  firstName: 'Anna',
  lastName: 'Admin',
  email: 'anna@tsv.example',
  isSuperAdmin: false,
} as User;

interface OrgState {
  country: string | null;
  operatingMode: 'orders_only' | 'cashless' | 'full';
  operatingModeLegacy: boolean;
}

/** Organisation, Verlauf und Admin-Protokoll im Speicher. */
function setup(
  state: Partial<OrgState> = {},
  options: {
    role?: OrganizationRole;
    selfHosted?: boolean;
    /** Cloud-TSE auf dem Server; `paidEvent`: eine bezahlte Veranstaltung steht an. */
    tse?: { paidEvent: boolean; comingSoon?: boolean };
  } = {},
) {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt e.V.',
    slug: 'tsv-musterstadt',
    billingAddress: null,
    createdAt: new Date('2026-05-01T10:00:00Z'),
    country: 'DE',
    operatingMode: 'full',
    operatingModeLegacy: true,
    operatingModeSince: new Date('2026-05-01T10:00:00Z'),
    ...state,
    settings: {
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      vatExempt: true,
      sumup: { apiKey: 'sup_sk_secret', merchantCode: 'M1' },
      address: {
        street: 'Sportplatzweg 1',
        zip: '12345',
        city: 'Musterstadt',
        country: 'DE',
      },
    },
  } as unknown as Organization;
  const history: Partial<OrganizationOperatingModeChange>[] = [];
  const audit: Record<string, unknown>[] = [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve([
          {
            country: stored.country,
            operating_mode: stored.operatingMode,
            operating_mode_legacy: stored.operatingModeLegacy,
            operating_mode_since: stored.operatingModeSince,
          },
        ]);
      }
      stored.operatingMode = params[1] as Organization['operatingMode'];
      stored.operatingModeLegacy = false;
      stored.operatingModeSince = params[2] as Date;
      return Promise.resolve([]);
    }),
    insert: jest.fn((entity: unknown, row: Record<string, unknown>) => {
      if (entity === OrganizationOperatingModeChange) history.unshift(row);
      else audit.push({ entity, ...row });
      return Promise.resolve();
    }),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
    getRepository: () => ({
      find: jest.fn(() => Promise.resolve(history)),
      findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    }),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save: jest.fn((org: Organization) => {
      Object.assign(stored, org);
      return Promise.resolve(org);
    }),
  };
  const userOrganizationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve({
        role: options.role ?? OrganizationRole.ADMIN,
      } as UserOrganization),
    ),
  };
  const none = undefined as never;
  const organizations = new OrganizationsService(
    organizationRepository as never,
    none,
    userOrganizationRepository as never,
    none,
    dataSource as never,
    none,
    none,
    none,
    none,
    none,
  );
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          OPERATOR_NAME: 'LUXCODE by Lukas Lukic-Spitznagel',
          OPERATOR_ADDRESS: 'Beispielweg 2|54321 Beispielstadt',
        })[key],
    ),
  };
  const gateway = { notifyOrganizationSettingsUpdated: jest.fn() };
  const plan = {
    eventId: 'event-1',
    eventName: 'Weihnachtsmarkt',
    eventStartDate: '2026-12-12T15:00:00.000Z',
    scheduledFor: '2026-12-12',
    missing: [],
  };
  const tseAuto = options.tse
    ? {
        available: options.tse.comingSoon !== true,
        availability:
          options.tse.comingSoon === true ? 'coming_soon' : 'available',
        planFor: jest.fn(() =>
          Promise.resolve(options.tse?.paidEvent ? plan : null),
        ),
        onModeSwitchedToFull: jest.fn(() =>
          Promise.resolve({ tseFollows: true, plan }),
        ),
      }
    : undefined;
  const service = new OperatingModeService(
    dataSource as never,
    organizations,
    config as never,
    { isSelfHosted: options.selfHosted === true } as never,
    gateway as never,
    tseAuto as never,
  );
  return {
    service,
    organizations,
    stored,
    history,
    audit,
    manager,
    gateway,
    tseAuto,
  };
}

async function responseOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => null,
    (e: { getResponse?: () => Record<string, unknown> }) => e.getResponse?.(),
  );
}

describe('OperatingModeService — switch by the club (admins)', () => {
  it('DE legacy → cashless: clears legacy, logs history and audit, notifies the tills', async () => {
    const t = setup();
    const state = await t.service.setByMember(ORG_ID, 'cashless', clubAdmin, {
      ipAddress: '203.0.113.7',
      userAgent: 'jest',
    });

    expect(state).toMatchObject({
      operatingMode: 'cashless',
      operatingModeLegacy: false,
      cashAllowed: false,
      pricesVisible: true,
      certificateAvailable: true,
    });
    expect(t.stored).toMatchObject({
      operatingMode: 'cashless',
      operatingModeLegacy: false,
    });
    expect(t.history[0]).toMatchObject({
      organizationId: ORG_ID,
      fromMode: 'full_legacy',
      toMode: 'cashless',
      reason: null,
      bySupport: false,
      changedByUserId: 'user-1',
      changedByName: 'Anna Admin (anna@tsv.example)',
      ipAddress: '203.0.113.7',
    });
    expect(t.audit[0]).toMatchObject({
      action: AdminAction.SET_OPERATING_MODE,
      adminUserId: 'user-1',
      organizationId: ORG_ID,
      details: {
        before: { operatingMode: 'full_legacy' },
        after: { operatingMode: 'cashless' },
        bySupport: false,
      },
    });
    expect(t.gateway.notifyOrganizationSettingsUpdated).toHaveBeenCalledWith(
      ORG_ID,
    );
  });

  it('DE: back to full only with an active TSE (403 TSE_REQUIRED_FOR_CASH)', async () => {
    const t = setup({ operatingMode: 'cashless', operatingModeLegacy: false });
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'full', clubAdmin)),
    ).toMatchObject({
      code: 'TSE_REQUIRED_FOR_CASH',
      reason: 'OPERATING_MODE_FULL_REQUIRES_TSE',
    });
    expect(t.history).toHaveLength(0);
    expect(t.stored.operatingMode).toBe('cashless');

    tseStatus.isActive = () => true;
    const state = await t.service.setByMember(ORG_ID, 'full', clubAdmin);
    expect(state).toMatchObject({
      operatingMode: 'full',
      tseActive: true,
      cashAllowed: true,
    });
  });

  it('DE: Cloud-TSE coming soon — full shows its own reason and stays blocked', async () => {
    const t = setup(
      { operatingMode: 'cashless', operatingModeLegacy: false },
      { tse: { paidEvent: false, comingSoon: true } },
    );
    const view = await t.service.getForMember(ORG_ID, clubAdmin);
    expect(view.options.find((o) => o.mode === 'full')).toEqual({
      mode: 'full',
      available: false,
      unavailableReason: 'tse_coming_soon',
    });
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'full', clubAdmin)),
    ).toMatchObject({
      code: 'TSE_REQUIRED_FOR_CASH',
      reason: 'OPERATING_MODE_FULL_REQUIRES_TSE',
    });
    expect(t.history).toHaveLength(0);
    expect(t.stored.operatingMode).toBe('cashless');
  });

  it('DE: full without TSE is allowed with a paid event — the Cloud-TSE follows automatically', async () => {
    const t = setup(
      { operatingMode: 'cashless', operatingModeLegacy: false },
      { tse: { paidEvent: true } },
    );
    const before = await t.service.getForMember(ORG_ID, clubAdmin);
    expect(before.options.find((o) => o.mode === 'full')).toEqual({
      mode: 'full',
      available: true,
      unavailableReason: null,
    });
    expect(before.tseSetup).toMatchObject({ scheduledFor: '2026-12-12' });

    const state = await t.service.setByMember(ORG_ID, 'full', clubAdmin);
    expect(state).toMatchObject({
      operatingMode: 'full',
      operatingModeLegacy: false,
      tseActive: false,
      // Bargeld erst mit aktiver TSE.
      cashAllowed: false,
      tseSetup: { scheduledFor: '2026-12-12', eventName: 'Weihnachtsmarkt' },
    });
    expect(t.tseAuto?.onModeSwitchedToFull).toHaveBeenCalledWith(
      ORG_ID,
      clubAdmin.id,
    );
  });

  it('DE: without a paid event full stays disabled (paid_event_required)', async () => {
    const t = setup(
      { operatingMode: 'cashless', operatingModeLegacy: false },
      { tse: { paidEvent: false } },
    );
    const before = await t.service.getForMember(ORG_ID, clubAdmin);
    expect(before.options.find((o) => o.mode === 'full')).toMatchObject({
      available: false,
      unavailableReason: 'paid_event_required',
    });
    expect(before.tseSetup).toBeNull();
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'full', clubAdmin)),
    ).toMatchObject({
      code: 'TSE_REQUIRED_FOR_CASH',
      reason: 'OPERATING_MODE_FULL_REQUIRES_TSE',
    });
    expect(t.tseAuto?.onModeSwitchedToFull).not.toHaveBeenCalled();
  });

  it('DE legacy: confirming full with a paid event ends the legacy status', async () => {
    const t = setup({}, { tse: { paidEvent: true } });
    const state = await t.service.setByMember(ORG_ID, 'full', clubAdmin);
    expect(state).toMatchObject({
      operatingMode: 'full',
      operatingModeLegacy: false,
    });
    expect(t.history[0]).toMatchObject({
      fromMode: 'full_legacy',
      toMode: 'full',
    });
    expect(t.tseAuto?.onModeSwitchedToFull).toHaveBeenCalled();
  });

  it('DE legacy: confirming full without TSE is not possible either', async () => {
    const t = setup();
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'full', clubAdmin)),
    ).toMatchObject({ code: 'TSE_REQUIRED_FOR_CASH' });
    expect(t.stored.operatingModeLegacy).toBe(true);
  });

  it.each(['AT', 'CH', 'FR'])(
    '%s legacy: confirming full clears legacy and is logged',
    async (country) => {
      const t = setup({ country });
      const state = await t.service.setByMember(ORG_ID, 'full', clubAdmin);
      expect(state).toMatchObject({
        operatingMode: 'full',
        operatingModeLegacy: false,
        cashAllowed: true,
        certificateAvailable: false,
      });
      expect(t.history[0]).toMatchObject({
        fromMode: 'full_legacy',
        toMode: 'full',
      });
    },
  );

  it('AT: all three modes are free to choose, also back to full', async () => {
    const t = setup({ country: 'AT', operatingModeLegacy: false });
    await t.service.setByMember(ORG_ID, 'orders_only', clubAdmin);
    await t.service.setByMember(ORG_ID, 'cashless', clubAdmin);
    await t.service.setByMember(ORG_ID, 'full', clubAdmin);
    expect(t.history.map((h) => `${h.fromMode}>${h.toMode}`)).toEqual([
      'cashless>full',
      'orders_only>cashless',
      'full>orders_only',
    ]);
  });

  it('the same mode again (not legacy) is rejected and writes nothing', async () => {
    const t = setup({ operatingMode: 'cashless', operatingModeLegacy: false });
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'cashless', clubAdmin)),
    ).toMatchObject({ reason: 'OPERATING_MODE_UNCHANGED' });
    expect(t.history).toHaveLength(0);
    expect(t.audit).toHaveLength(0);
  });

  it('without a country no mode can be chosen (400 COUNTRY_REQUIRED)', async () => {
    const t = setup({ country: null });
    expect(
      await responseOf(t.service.setByMember(ORG_ID, 'cashless', clubAdmin)),
    ).toMatchObject({ reason: 'COUNTRY_REQUIRED' });
    expect(t.history).toHaveLength(0);
  });

  it('only admins of the organization can switch', async () => {
    const t = setup({}, { role: OrganizationRole.MEMBER });
    await expect(
      t.service.setByMember(ORG_ID, 'cashless', clubAdmin),
    ).rejects.toMatchObject({ status: 403 });
    expect(t.history).toHaveLength(0);
  });

  it('members see options, history and who switched (support anonymised)', async () => {
    const t = setup({ operatingModeLegacy: false, operatingMode: 'cashless' });
    await t.service.setByMember(ORG_ID, 'orders_only', clubAdmin);
    await t.service.adminSetMode(
      ORG_ID,
      'cashless',
      'Antrag per E-Mail vom 02.11.2026',
      superAdmin,
    );
    const view = await t.service.getForMember(ORG_ID, clubAdmin);
    expect(view.options).toEqual([
      { mode: 'orders_only', available: true, unavailableReason: null },
      { mode: 'cashless', available: true, unavailableReason: null },
      { mode: 'full', available: false, unavailableReason: 'tse_required' },
    ]);
    expect(view.history.map((h) => h.changedByName)).toEqual([
      'OpenEOS-Support',
      'Anna Admin (anna@tsv.example)',
    ]);
    expect(view.history[0]).toMatchObject({
      bySupport: true,
      reason: 'Antrag per E-Mail vom 02.11.2026',
    });
  });
});

describe('OperatingModeService — switch by the support', () => {
  it('stores the reason, the real name and the audit entry', async () => {
    const t = setup({ country: 'AT', operatingModeLegacy: false });
    await t.service.adminSetMode(
      ORG_ID,
      'orders_only',
      '  Antrag des Vereins per E-Mail  ',
      superAdmin,
    );
    expect(t.history[0]).toMatchObject({
      fromMode: 'full',
      toMode: 'orders_only',
      reason: 'Antrag des Vereins per E-Mail',
      bySupport: true,
      changedByName: 'Sam Support (support@openeos.example)',
    });
    expect(t.audit[0]).toMatchObject({
      action: AdminAction.SET_OPERATING_MODE,
      adminUserId: 'support-1',
      reason: 'Antrag des Vereins per E-Mail',
    });
  });

  it('the support cannot enable cash in DE without TSE either', async () => {
    const t = setup({ operatingMode: 'cashless', operatingModeLegacy: false });
    expect(
      await responseOf(
        t.service.adminSetMode(ORG_ID, 'full', 'Bitte Bargeld', superAdmin),
      ),
    ).toMatchObject({ code: 'TSE_REQUIRED_FOR_CASH' });
  });
});

describe('Routes', () => {
  const routes = (controller: { prototype: object }) => {
    const proto = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .map((name) => proto[name])
      .filter((fn): fn is object => typeof fn === 'function')
      .map((fn) => ({
        path: Reflect.getMetadata(PATH_METADATA, fn) as string | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined,
        saasOnly: Reflect.getMetadata(SAAS_ONLY_KEY, fn) as boolean | undefined,
      }))
      .filter((r) => typeof r.path === 'string');
  };

  it('the club switches via PATCH /organizations/:id/operating-mode', () => {
    const org = routes(OrganizationsController);
    expect(
      org.find((r) => r.path === ':id/operating-mode' && r.method === 4),
    ).toBeDefined(); // PATCH
    expect(
      org.find(
        (r) => r.path === ':id/operating-mode/certificate.pdf' && r.saasOnly,
      ),
    ).toBeDefined();
  });

  it('the support switches in the guarded admin controller (SaaS only)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminController,
    ) as unknown[];
    expect(guards).toContain(SuperAdminGuard);
    const admin = routes(AdminController);
    expect(
      admin.find(
        (r) =>
          r.path === 'organizations/:id/operating-mode' &&
          r.method === 4 &&
          r.saasOnly,
      ),
    ).toBeDefined();
  });

  it('the interim switches are gone', () => {
    const paths = [
      ...routes(OrganizationsController),
      ...routes(AdminController),
    ].map((r) => r.path ?? '');
    for (const removed of ['payments/cashless', 'cash-policy']) {
      expect(paths.filter((p) => p.includes(removed))).toEqual([]);
    }
  });

  it('the organization PATCH cannot set mode or the interim fields', async () => {
    const t = setup({ operatingMode: 'cashless', operatingModeLegacy: false });
    const result = await t.organizations.update(
      ORG_ID,
      {
        settings: {
          operatingMode: 'full',
          operatingModeSince: '2020-01-01T00:00:00.000Z',
          payments: { cashless: false },
          vatExempt: false,
        },
      } as never,
      clubAdmin,
    );
    expect(result.operatingMode).toBe('cashless');
    expect(result.settings).not.toHaveProperty('operatingMode');
    expect(result.settings).not.toHaveProperty('payments');
    expect(result.settings.vatExempt).toBe(false);
  });

  it('the generic super-admin edit cannot set the mode either', async () => {
    const org = {
      id: ORG_ID,
      name: 'TSV',
      country: 'DE',
      operatingMode: 'cashless',
      settings: { currency: 'EUR' },
    };
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(structuredClone(org))),
      save: jest.fn((o: Organization) => Promise.resolve(o)),
    };
    const auditLogRepository = {
      create: jest.fn((x: object) => x),
      save: jest.fn(() => Promise.resolve()),
    };
    const none = undefined as never;
    const admin = new AdminService(
      organizationRepository as never,
      none,
      none,
      none,
      auditLogRepository as never,
      none,
      none,
      none,
      none,
      none,
      none,
    );
    const saved = await admin.updateOrganization(
      ORG_ID,
      { settings: { currency: 'EUR', operatingMode: 'full' } },
      'support-1',
      '127.0.0.1',
    );
    expect(saved.operatingMode).toBe('cashless');
    expect(saved.settings).not.toHaveProperty('operatingMode');
  });
});

describe('Herstellerbescheinigung', () => {
  it.each([
    ['DE full (legacy)', { country: 'DE' }],
    ['DE full with TSE', { country: 'DE', operatingModeLegacy: false }],
    [
      'AT cashless',
      { country: 'AT', operatingMode: 'cashless', operatingModeLegacy: false },
    ],
  ] as [string, Partial<OrgState>][])(
    'not available for %s',
    async (_label, state) => {
      tseStatus.isActive = () => true;
      const t = setup(state);
      expect(
        await responseOf(t.service.certificatePdf(ORG_ID, clubAdmin)),
      ).toMatchObject({ reason: 'CERTIFICATE_NOT_AVAILABLE' });
    },
  );

  it('not on self-hosted installations', async () => {
    const t = setup(
      { operatingMode: 'cashless', operatingModeLegacy: false },
      { selfHosted: true },
    );
    expect(
      await responseOf(t.service.certificatePdf(ORG_ID, clubAdmin)),
    ).toMatchObject({ reason: 'CERTIFICATE_NOT_AVAILABLE' });
  });

  it('only for admins of the organization', async () => {
    const t = setup(
      { operatingMode: 'cashless', operatingModeLegacy: false },
      { role: OrganizationRole.MEMBER },
    );
    await expect(
      t.service.certificatePdf(ORG_ID, clubAdmin),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(['cashless', 'orders_only'] as const)(
    'renders a PDF in DE for %s',
    async (mode) => {
      const t = setup();
      await t.service.setByMember(ORG_ID, mode, clubAdmin);
      const { pdf, filename } = await t.service.certificatePdf(
        ORG_ID,
        clubAdmin,
      );
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(filename).toMatch(
        /^openeos-herstellerbescheinigung-tsv-musterstadt-\d{4}-\d{2}-\d{2}\.pdf$/,
      );
    },
  );

  it('states what the authorities need (content)', () => {
    const base = {
      organization: {
        id: ORG_ID,
        name: 'TSV Musterstadt e.V.',
        address: {
          street: 'Sportplatzweg 1',
          zip: '12345',
          city: 'Musterstadt',
          country: 'DE',
        },
      },
      country: 'DE',
      tseActive: false,
      since: new Date('2026-11-02T09:30:00Z'),
      issuedAt: new Date('2026-11-02T10:00:00Z'),
      version: '1.8.0',
      operator: operatorFromEnv(
        (k) =>
          ({
            OPERATOR_NAME: 'LUXCODE by Lukas Lukic-Spitznagel',
            OPERATOR_ADDRESS: 'Beispielweg 2|54321 Beispielstadt',
          })[k],
      ),
      timeZone: 'Europe/Berlin',
      history: [
        {
          at: new Date('2026-11-02T09:00:00Z'),
          fromMode: 'full_legacy',
          toMode: 'cashless',
          reason: 'Umstellung auf Betriebsarten (vorher: bargeldloser Modus)',
          bySupport: true,
        },
        {
          at: new Date('2026-11-02T09:30:00Z'),
          fromMode: 'cashless',
          toMode: 'orders_only',
          reason: null,
          bySupport: false,
        },
      ],
    };
    for (const mode of ['cashless', 'orders_only'] as const) {
      const content = buildCertificateContent({ ...base, mode });
      const text = JSON.stringify(content);
      expect(content.title).toBe('Herstellerbescheinigung');
      expect(text).toContain(
        'Bargeld kann in dieser Organisation nicht erfasst werden; Bargeld ist ausschließlich mit aktiver zertifizierter TSE möglich.',
      );
      expect(text).toContain('Deutschland (DE)');
      expect(text).toContain('keine aktive TSE');
      expect(text).toContain('02.11.2026, 10:30 Uhr');
      expect(content.history.heading).toBe('Verlauf der Betriebsart');
      expect(content.history.rows).toEqual([
        [
          '02.11.2026, 10:00 Uhr',
          '„Alle Funktionen (Bestand)“ zu „Bargeldlos“',
          'Umstellung auf Betriebsarten (vorher: bargeldloser Modus) (OpenEOS-Support)',
        ],
        [
          '02.11.2026, 10:30 Uhr',
          '„Bargeldlos“ zu „Nur Bons“',
          'Durch die Organisation',
        ],
      ]);
      expect(content.operator.lines).toEqual([
        'LUXCODE by Lukas Lukic-Spitznagel',
        'Beispielweg 2',
        '54321 Beispielstadt',
        'hello@openeos.de',
      ]);
    }
    expect(
      JSON.stringify(buildCertificateContent({ ...base, mode: 'orders_only' })),
    ).toContain('ohne Preise');
  });

  it('renders the content as PDF', async () => {
    const pdf = await renderCertificatePdf(
      buildCertificateContent({
        organization: { id: ORG_ID, name: 'TSV', address: null },
        mode: 'cashless',
        country: 'DE',
        tseActive: false,
        since: new Date(),
        issuedAt: new Date(),
        version: 'dev',
        operator: operatorFromEnv(() => undefined),
        timeZone: 'Europe/Berlin',
        history: [],
      }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('operator defaults when no environment is set', () => {
    expect(operatorFromEnv(() => undefined)).toEqual({
      name: 'LUXCODE by Lukas Lukic-Spitznagel',
      addressLines: [],
      email: 'hello@openeos.de',
    });
  });
});
