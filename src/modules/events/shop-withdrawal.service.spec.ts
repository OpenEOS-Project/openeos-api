import { NotFoundException } from '@nestjs/common';

import {
  ShopWithdrawalService,
  withdrawalUrl,
} from './shop-withdrawal.service';

const EVENT = {
  id: 'e1',
  name: 'Sommerfest',
  organizationId: 'o1',
  settings: { shop: { enabled: false } },
};

function setup(
  opts: {
    withdrawalRight?: boolean;
    orderRows?: { id: string }[];
    shopConfigured?: boolean;
  } = {},
) {
  const saved: Record<string, unknown>[] = [];
  const withdrawals = {
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) => {
      const row = {
        id: 'w1',
        receivedAt: new Date('2026-11-12T10:00:00Z'),
        ...v,
      };
      saved.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({})),
  };
  const events = {
    findOne: jest.fn(() =>
      Promise.resolve(
        opts.shopConfigured === false ? { ...EVENT, settings: {} } : EVENT,
      ),
    ),
  };
  const organizations = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: 'o1',
        name: 'TSV Musterstadt',
        settings: {
          legal: {
            imprintUrl: 'https://tsv.example/impressum',
            privacyText: 'Datenschutz',
            contactEmail: 'Kasse@TSV.example',
            withdrawalRight: opts.withdrawalRight ?? true,
          },
        },
      }),
    ),
  };
  const dataSource = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM orders')
          ? (opts.orderRows ?? [])
          : [{ email: 'admin@tsv.example' }, { email: 'kasse@tsv.example' }],
      ),
    ),
  };
  const email = {
    sendShopWithdrawalConfirmation: jest.fn(() => Promise.resolve(true)),
    sendShopWithdrawalToClub: jest.fn(() => Promise.resolve(true)),
  };
  const deployment = { platformLegal: { imprintUrl: null, privacyUrl: null } };
  const service = new ShopWithdrawalService(
    withdrawals as never,
    events as never,
    organizations as never,
    dataSource as never,
    email as never,
    deployment as never,
  );
  return { service, saved, email, withdrawals };
}

const DTO = {
  name: 'Erika Muster',
  email: 'Erika@Example.test',
  orderNumber: ' W-42 ',
};

describe('ShopWithdrawalService', () => {
  it('is only available when the club declared a withdrawal right', async () => {
    await expect(
      setup({ withdrawalRight: false }).service.info('e1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      setup({ shopConfigured: false }).service.info('e1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Auch nach dem Abschalten des Shops (Ende der Veranstaltung) erreichbar.
    await expect(setup().service.info('e1')).resolves.toMatchObject({
      event: { id: 'e1', name: 'Sommerfest' },
      organizationName: 'TSV Musterstadt',
    });
  });

  it('stores the withdrawal, confirms it with content and time and forwards it to the club', async () => {
    const { service, saved, email, withdrawals } = setup({
      orderRows: [{ id: 'order-1' }],
    });
    const receipt = await service.submit('e1', DTO);
    expect(receipt).toEqual({
      receivedAt: '2026-11-12T10:00:00.000Z',
      reference: 'w1',
    });
    expect(saved[0]).toMatchObject({
      organizationId: 'o1',
      eventId: 'e1',
      orderId: 'order-1',
      orderReference: 'W-42',
      email: 'erika@example.test',
      message: null,
    });
    expect(email.sendShopWithdrawalConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'erika@example.test',
        orderReference: 'W-42',
        reference: 'w1',
      }),
    );
    // Kontaktadresse und Admins, ohne Doppel.
    expect(
      email.sendShopWithdrawalToClub.mock.calls.map(
        ([o]) => (o as { to: string }).to,
      ),
    ).toEqual(['kasse@tsv.example', 'admin@tsv.example']);
    expect(email.sendShopWithdrawalToClub).toHaveBeenCalledWith(
      expect.objectContaining({ orderFound: true }),
    );
    expect(withdrawals.update).toHaveBeenCalledTimes(2);
  });

  it('accepts withdrawals it cannot match to an order and tells the club', async () => {
    const { service, email, saved } = setup({ orderRows: [] });
    await service.submit('e1', { ...DTO, message: 'Nur die Getränke' });
    expect(saved[0]).toMatchObject({
      orderId: null,
      message: 'Nur die Getränke',
    });
    expect(email.sendShopWithdrawalToClub).toHaveBeenCalledWith(
      expect.objectContaining({ orderFound: false }),
    );
  });

  it('drops honeypot submissions without storing', async () => {
    const { service, saved, email } = setup();
    await service.submit('e1', { ...DTO, website: 'spam' });
    expect(saved).toHaveLength(0);
    expect(email.sendShopWithdrawalConfirmation).not.toHaveBeenCalled();
  });

  it('builds the shop link of the withdrawal page', () => {
    expect(withdrawalUrl('https://shop.openeos.de/', 'e1')).toBe(
      'https://shop.openeos.de/widerruf/e1',
    );
  });
});
