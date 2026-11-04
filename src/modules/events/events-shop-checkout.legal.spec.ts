import { ForbiddenException } from '@nestjs/common';

import { EventStatus } from '../../database/entities/event.entity';
import { EventsShopCheckoutController } from './events-shop-checkout.controller';

/*
 * Without the club's imprint and privacy notice the shop must not take
 * orders — also not via a direct API call or an open browser tab.
 */

const EVENT_ID = '0b9e2a8c-6a0f-4f53-9d3a-3a4f1c2b7e10';
const ORG_ID = '5d1c7f3e-2b8a-4e6d-9c1f-7a2b3c4d5e6f';

function setup(legal: Record<string, string> | undefined) {
  const event = {
    id: EVENT_ID,
    organizationId: ORG_ID,
    // Test mode skips the opening-hours check.
    status: EventStatus.TEST,
    settings: { shop: { enabled: true } },
  };
  const organization = {
    id: ORG_ID,
    name: 'TSV Musterstadt',
    country: 'DE',
    operatingMode: 'cashless',
    settings: {
      integrations: { sumup: { enabled: true } },
      ...(legal ? { legal } : {}),
    },
  };
  const repo = () => ({
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    save: jest.fn(),
    create: jest.fn(),
  });
  const eventRepository = repo();
  eventRepository.findOne.mockResolvedValue(event);
  const organizationRepository = repo();
  organizationRepository.findOne.mockResolvedValue(organization);
  const productRepository = repo();
  const shopCheckoutRepository = repo();
  const sumupApi = { createCheckout: jest.fn() };

  const controller = new EventsShopCheckoutController(
    eventRepository as never,
    organizationRepository as never,
    productRepository as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    shopCheckoutRepository as never,
    sumupApi as never,
    {} as never,
    {} as never,
    { get: jest.fn((_key: string, fallback: unknown) => fallback) } as never,
    {} as never,
  );
  return { controller, productRepository, shopCheckoutRepository, sumupApi };
}

const body = {
  email: 'gast@example.org',
  customerName: { firstName: 'Max', lastName: 'Muster' },
  items: [{ productId: 'p1', quantity: 1 }],
};

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { getResponse?: () => unknown };
  }
  throw new Error('expected createCheckout to throw');
}

describe('EventsShopCheckoutController – club legal info', () => {
  it.each([
    ['nothing', undefined],
    ['only the imprint', { imprintUrl: 'https://tsv.example/impressum' }],
    ['only the privacy notice', { privacyText: 'Datenschutzhinweis …' }],
  ])('rejects the checkout when %s is stored', async (_label, legal) => {
    const { controller, productRepository, shopCheckoutRepository, sumupApi } =
      setup(legal);

    const error = await errorOf(controller.createCheckout(EVENT_ID, body));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse?.()).toMatchObject({ code: 'LEGAL_INFO_MISSING' });
    expect(productRepository.find).not.toHaveBeenCalled();
    expect(shopCheckoutRepository.save).not.toHaveBeenCalled();
    expect(sumupApi.createCheckout).not.toHaveBeenCalled();
  });

  it('lets the checkout continue once imprint and privacy notice exist', async () => {
    const { controller } = setup({
      imprintUrl: 'https://tsv.example/impressum',
      privacyText: 'Datenschutzhinweis …',
    });

    // The next check (SumUp credentials) answers — the legal guard passed.
    const error = await errorOf(controller.createCheckout(EVENT_ID, body));
    expect(error.getResponse?.()).toMatchObject({
      code: 'SUMUP_NOT_CONFIGURED',
    });
  });
});
