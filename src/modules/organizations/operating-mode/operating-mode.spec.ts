import 'reflect-metadata';
import { ForbiddenException, Logger } from '@nestjs/common';
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

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '2a3f1c52-4f43-4a3e-9f8e-0f2b8f3f1a77';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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

/** Organisation, Verlauf und Admin-Protokoll im Speicher. */
function setup(
  role: OrganizationRole = OrganizationRole.ADMIN,
  settings: Record<string, unknown> = {},
) {
  const stored = {
    id: ORG_ID,
    name: 'TSV Musterstadt e.V.',
    slug: 'tsv-musterstadt',
    billingAddress: null,
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
      ...settings,
    },
  } as unknown as Organization;
  const history: Partial<OrganizationOperatingModeChange>[] = [];
  const audit: Record<string, unknown>[] = [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve([{ settings: stored.settings }]);
      }
      stored.settings = {
        ...stored.settings,
        ...(JSON.parse(params[1] as string) as object),
      };
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
    }),
  };
  const organizationRepository = {
    findOne: jest.fn(() => Promise.resolve(structuredClone(stored))),
    save: jest.fn((org: Organization) => Promise.resolve(org)),
  };
  const userOrganizationRepository = {
    findOne: jest.fn(() => Promise.resolve({ role } as UserOrganization)),
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
  const service = new OperatingModeService(
    organizationRepository as never,
    dataSource as never,
    organizations,
    config as never,
  );
  return { service, organizations, stored, history, audit, manager };
}

describe('OperatingModeService.setMode (support only)', () => {
  it('switches to order_only, keeps all other settings and logs history and audit', async () => {
    const { service, stored, history, audit } = setup();

    const state = await service.setMode(
      ORG_ID,
      'order_only',
      '  Antrag des Vereins per E-Mail vom 01.11.2026  ',
      superAdmin,
      { ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' },
    );

    expect(state.operatingMode).toBe('order_only');
    expect(stored.settings.operatingMode).toBe('order_only');
    expect(stored.settings.operatingModeSince).toBe(state.operatingModeSince);
    expect(stored.settings.sumup).toEqual({
      apiKey: 'sup_sk_secret',
      merchantCode: 'M1',
    });
    expect(history).toEqual([
      expect.objectContaining({
        organizationId: ORG_ID,
        fromMode: 'pos',
        toMode: 'order_only',
        reason: 'Antrag des Vereins per E-Mail vom 01.11.2026',
        changedByUserId: 'support-1',
        changedByName: 'Sam Support (support@openeos.example)',
        ipAddress: '203.0.113.9',
      }),
    ]);
    expect(audit).toEqual([
      expect.objectContaining({
        adminUserId: 'support-1',
        organizationId: ORG_ID,
        action: AdminAction.SET_OPERATING_MODE,
        reason: 'Antrag des Vereins per E-Mail vom 01.11.2026',
        details: {
          before: { operatingMode: 'pos' },
          after: { operatingMode: 'order_only' },
        },
      }),
    ]);
  });

  it('switching back is possible and logged as well', async () => {
    const { service, history } = setup(OrganizationRole.ADMIN, {
      operatingMode: 'order_only',
    });
    await service.setMode(
      ORG_ID,
      'pos',
      'Verein will wieder kassieren',
      superAdmin,
    );
    expect(history[0]).toMatchObject({ fromMode: 'order_only', toMode: 'pos' });
  });

  it('rejects a switch to the current mode and writes nothing', async () => {
    const { service, history, audit } = setup(OrganizationRole.ADMIN, {
      operatingMode: 'order_only',
    });
    await expect(
      service.setMode(ORG_ID, 'order_only', 'doppelt geklickt', superAdmin),
    ).rejects.toMatchObject({
      response: { reason: 'OPERATING_MODE_UNCHANGED' },
    });
    expect(history).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});

describe('Who can switch', () => {
  it('the switch lives only in the super-admin controller (guarded, SaaS only)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminController,
    ) as unknown[];
    expect(guards).toContain(SuperAdminGuard);

    const handler = Object.getOwnPropertyDescriptor(
      AdminController.prototype,
      'setOperatingMode',
    )?.value as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'organizations/:id/operating-mode',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(4); // PATCH
    expect(Reflect.getMetadata(SAAS_ONLY_KEY, handler)).toBe(true);
  });

  it('the organization API has no writing route for the mode', () => {
    const proto = OrganizationsController.prototype as unknown as Record<
      string,
      unknown
    >;
    const writing = Object.getOwnPropertyNames(proto)
      .map((name) => proto[name])
      .filter(
        (fn): fn is (...a: unknown[]) => unknown => typeof fn === 'function',
      )
      .filter((fn) => {
        const path = Reflect.getMetadata(PATH_METADATA, fn) as
          | string
          | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as
          | number
          | undefined;
        return (
          typeof path === 'string' &&
          path.includes('operating-mode') &&
          method !== undefined &&
          method !== 0 // GET
        );
      });
    expect(writing).toEqual([]);
  });

  it('the organization PATCH (and create) cannot set the mode', async () => {
    const { organizations } = setup(OrganizationRole.ADMIN, {
      operatingMode: 'order_only',
      operatingModeSince: '2026-11-01T09:00:00.000Z',
    });

    const result = await organizations.update(
      ORG_ID,
      {
        settings: {
          operatingMode: 'pos',
          operatingModeSince: '2020-01-01T00:00:00.000Z',
          vatExempt: false,
        },
      } as never,
      clubAdmin,
    );

    expect(result.settings.operatingMode).toBe('order_only');
    expect(result.settings.operatingModeSince).toBe('2026-11-01T09:00:00.000Z');
    expect(result.settings.vatExempt).toBe(false);
  });

  it('the generic super-admin edit keeps the mode as it is', async () => {
    const org = {
      id: ORG_ID,
      name: 'TSV',
      settings: { operatingMode: 'order_only', operatingModeSince: 'T1' },
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
      { settings: { currency: 'EUR', operatingMode: 'pos' } },
      'support-1',
      '127.0.0.1',
    );
    expect(saved.settings).toMatchObject({
      currency: 'EUR',
      operatingMode: 'order_only',
      operatingModeSince: 'T1',
    });
  });
});

describe('Herstellerbescheinigung', () => {
  it('is only available in order_only mode', async () => {
    const { service } = setup();
    await expect(
      service.certificatePdf(ORG_ID, clubAdmin),
    ).rejects.toMatchObject({
      response: { reason: 'CERTIFICATE_REQUIRES_ORDER_ONLY' },
    });
  });

  it('only for admins of the organization', async () => {
    const { service } = setup(OrganizationRole.MEMBER, {
      operatingMode: 'order_only',
      operatingModeSince: '2026-11-01T09:00:00.000Z',
    });
    await expect(
      service.certificatePdf(ORG_ID, clubAdmin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('renders a PDF for an admin after the switch', async () => {
    const { service } = setup();
    await service.setMode(
      ORG_ID,
      'order_only',
      'Antrag vom 01.11.2026',
      superAdmin,
    );

    const { pdf, filename } = await service.certificatePdf(ORG_ID, clubAdmin);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
    expect(filename).toMatch(
      /^openeos-herstellerbescheinigung-tsv-musterstadt-\d{4}-\d{2}-\d{2}\.pdf$/,
    );
  });

  it('states what the authorities need (content)', async () => {
    const content = buildCertificateContent({
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
      since: new Date('2026-11-01T09:30:00.000Z'),
      issuedAt: new Date('2026-11-02T08:00:00.000Z'),
      version: '1.8.0',
      operator: operatorFromEnv(
        (key) =>
          ({
            OPERATOR_ADDRESS: 'Beispielweg 2|54321 Beispielstadt',
          })[key],
      ),
      timeZone: 'Europe/Berlin',
      history: [
        {
          at: new Date('2026-11-01T09:30:00.000Z'),
          fromMode: 'pos',
          toMode: 'order_only',
          reason: 'Antrag des Vereins per E-Mail',
        },
      ],
    });
    const text = JSON.stringify(content);

    expect(content.title).toBe('Herstellerbescheinigung');
    expect(content.organization.lines).toEqual([
      'TSV Musterstadt e.V.',
      'Sportplatzweg 1',
      '12345 Musterstadt',
    ]);
    expect(content.operator.lines).toEqual([
      'LUXCODE by Lukas Lukic-Spitznagel',
      'Beispielweg 2',
      '54321 Beispielstadt',
      'hello@openeos.de',
    ]);
    expect(content.facts).toContainEqual(['Version', '1.8.0']);
    expect(content.facts).toContainEqual([
      'Gültig seit',
      '01.11.2026, 10:30 Uhr',
    ]);
    expect(text).toContain('seit dem 01.11.2026, 10:30 Uhr');
    expect(text).toContain('Kassen- und Zahlungsmodul');
    expect(text).toContain(
      'kann das Kassen- und Zahlungsmodul nicht selbst aktivieren',
    );
    expect(text).toContain('ausschließlich durch den Hersteller');
    expect(text).toContain('offene Ladenkasse');
    expect(text).toContain('Vorkasse im Online-Shop');
    expect(text).toContain('Küche');
    expect(text).toContain('maschinell erstellt');
    expect(content.history.rows).toEqual([
      [
        '01.11.2026, 10:30 Uhr',
        '„Kasse“ zu „Nur Bestellen“',
        'Antrag des Vereins per E-Mail',
      ],
    ]);
    // Keine Unterschrift, kein Bild einer Unterschrift.
    expect(text).not.toMatch(/Unterschrift des/);

    const pdf = await renderCertificatePdf(content);
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
