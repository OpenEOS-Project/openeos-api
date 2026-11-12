import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { OnlineOrderSession } from '../../database/entities/online-order-session.entity';
import type { DeploymentService } from '../../common/services/deployment.service';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const COMPLETE_LEGAL = {
  imprintUrl: 'https://tsv.example/impressum',
  privacyText: 'Verantwortlich ist der TSV Musterstadt e.V.',
};

function session(legal: Record<string, string> | undefined) {
  const s = new OnlineOrderSession();
  Object.assign(s, {
    id: 'session-1',
    organizationId: 'org-1',
    eventId: 'event-1',
    tableNumber: '12',
    status: 'active',
    cart: { items: [], updatedAt: new Date().toISOString() },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    organization: {
      id: 'org-1',
      name: 'TSV Musterstadt',
      settings: legal ? { legal } : {},
    },
  });
  return s;
}

function service(current: OnlineOrderSession) {
  const sessionRepository = {
    findOne: jest.fn(() => Promise.resolve(current)),
    save: jest.fn((s: OnlineOrderSession) => Promise.resolve(s)),
  } as unknown as Repository<OnlineOrderSession>;
  const orderRepository = { save: jest.fn() };
  const none = undefined as never;
  const svc = new OnlineOrdersService(
    sessionRepository,
    none,
    none,
    none,
    orderRepository as never,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  return { svc, orderRepository };
}

describe('QR order — legal information of the club', () => {
  it.each([
    ['nothing', undefined],
    ['only an imprint', { imprintUrl: 'https://tsv.example/impressum' }],
    ['only a privacy notice', { privacyText: 'Text' }],
  ])(
    'refuses to place an order with %s (403 LEGAL_INFO_MISSING)',
    async (_label, legal) => {
      const { svc, orderRepository } = service(session(legal));
      const result = svc.submitOrder('token', {});
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      await expect(result).rejects.toMatchObject({
        response: { code: 'LEGAL_INFO_MISSING' },
      });
      expect(orderRepository.save).not.toHaveBeenCalled();
    },
  );

  it('lets the order through once imprint and privacy notice exist', async () => {
    const { svc } = service(session(COMPLETE_LEGAL));
    // Leerer Warenkorb: die Pruefung danach greift, die rechtliche nicht.
    await expect(svc.submitOrder('token', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns the legal links with the session info', async () => {
    const { svc } = service(session(COMPLETE_LEGAL));
    const deployment = {
      platformLegal: {
        imprintUrl: 'https://openeos.de/impressum',
        privacyUrl: 'https://openeos.de/datenschutz',
      },
    } as DeploymentService;
    const controller = new OnlineOrdersController(svc, deployment);

    const { data } = await controller.getSession({
      'x-session-token': 'token',
    });

    expect(data.legal).toEqual({
      organizationName: 'TSV Musterstadt',
      imprintUrl: 'https://tsv.example/impressum',
      imprintText: null,
      privacyUrl: null,
      privacyText: 'Verantwortlich ist der TSV Musterstadt e.V.',
      contactEmail: null,
      complete: true,
      withdrawalRight: false,
      platform: deployment.platformLegal,
    });
  });

  it('marks missing legal information as incomplete', async () => {
    const { svc } = service(session(undefined));
    const controller = new OnlineOrdersController(svc, {
      platformLegal: { imprintUrl: null, privacyUrl: null },
    } as DeploymentService);

    const { data } = await controller.getSession({
      'x-session-token': 'token',
    });

    expect(data.legal.complete).toBe(false);
  });
});
