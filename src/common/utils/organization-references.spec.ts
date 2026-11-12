import { BadRequestException } from '@nestjs/common';

import { ErrorReasons } from '../constants/error-codes';
import {
  assertReferencesInOrganization,
  referenceSql,
  withoutForeignEvent,
} from './organization-references';
import { fakeReferenceDb } from './organization-references.fake-spec';

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const EVENT = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '10000000-0000-4000-8000-000000000002';
const SECOND_EVENT = '10000000-0000-4000-8000-000000000003';
const CAT = '20000000-0000-4000-8000-000000000001';
const FOREIGN_CAT = '20000000-0000-4000-8000-000000000002';
const SIBLING_CAT = '20000000-0000-4000-8000-000000000003';
const PFAND = '30000000-0000-4000-8000-000000000001';
const FOREIGN_PFAND = '30000000-0000-4000-8000-000000000002';
const ORDER = '40000000-0000-4000-8000-000000000001';
const ORDER_2 = '40000000-0000-4000-8000-000000000002';
const ITEM = '50000000-0000-4000-8000-000000000001';
const DELETED_PRODUCT = '60000000-0000-4000-8000-000000000001';

function db() {
  return fakeReferenceDb({
    events: [
      { id: EVENT, organization_id: ORG },
      { id: SECOND_EVENT, organization_id: ORG },
      { id: OTHER_EVENT, organization_id: OTHER_ORG },
    ],
    categories: [
      { id: CAT, event_id: EVENT },
      { id: SIBLING_CAT, event_id: SECOND_EVENT },
      { id: FOREIGN_CAT, event_id: OTHER_EVENT },
    ],
    pfand_types: [
      { id: PFAND, organization_id: ORG },
      { id: FOREIGN_PFAND, organization_id: OTHER_ORG },
    ],
    orders: [
      { id: ORDER, organization_id: ORG },
      { id: ORDER_2, organization_id: ORG },
    ],
    order_items: [{ id: ITEM, order_id: ORDER }],
    products: [
      { id: DELETED_PRODUCT, event_id: EVENT, deleted_at: new Date() },
    ],
  });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as BadRequestException;
  }
  throw new Error('expected a rejection');
}

describe('assertReferencesInOrganization', () => {
  it('accepts records of the same organization and event', async () => {
    await expect(
      assertReferencesInOrganization(
        db(),
        { organizationId: ORG, eventId: EVENT },
        [
          { kind: 'category', ids: CAT },
          { kind: 'pfandType', ids: [PFAND] },
        ],
      ),
    ).resolves.toBeUndefined();
  });

  it('skips empty references without a query', async () => {
    const fake = db();
    await assertReferencesInOrganization(fake, { organizationId: ORG }, [
      { kind: 'category', ids: null },
      { kind: 'pfandType', ids: undefined },
      { kind: 'printer', ids: [] },
      { kind: 'event', ids: '' },
    ]);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('rejects a category from another organization', async () => {
    const error = await rejection(
      assertReferencesInOrganization(db(), { organizationId: ORG }, [
        { kind: 'category', ids: FOREIGN_CAT, field: 'categoryId' },
      ]),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      reason: ErrorReasons.CATEGORY_NOT_FOUND,
      params: { field: 'categoryId' },
    });
  });

  it('rejects a category of another event of the same organization', async () => {
    await expect(
      assertReferencesInOrganization(
        db(),
        { organizationId: ORG, eventId: EVENT },
        [{ kind: 'category', ids: SIBLING_CAT }],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a deposit type from another organization', async () => {
    const error = await rejection(
      assertReferencesInOrganization(db(), { organizationId: ORG }, [
        { kind: 'pfandType', ids: [PFAND, FOREIGN_PFAND] },
      ]),
    );
    expect(error.getResponse()).toMatchObject({
      reason: ErrorReasons.DEPOSIT_TYPE_NOT_FOUND,
    });
  });

  it('rejects unknown and malformed ids without querying malformed ones', async () => {
    const fake = db();
    await expect(
      assertReferencesInOrganization(fake, { organizationId: ORG }, [
        { kind: 'event', ids: 'not-a-uuid' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.query).not.toHaveBeenCalled();
    await expect(
      assertReferencesInOrganization(fake, { organizationId: ORG }, [
        { kind: 'event', ids: '10000000-0000-4000-8000-0000000000ff' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats deleted records as missing', async () => {
    await expect(
      assertReferencesInOrganization(
        db(),
        { organizationId: ORG, eventId: EVENT },
        [{ kind: 'product', ids: DELETED_PRODUCT }],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('compares ids case-insensitively', async () => {
    await expect(
      assertReferencesInOrganization(db(), { organizationId: ORG }, [
        { kind: 'pfandType', ids: PFAND.toUpperCase() },
      ]),
    ).resolves.toBeUndefined();
  });

  it('checks order items against the given order', async () => {
    await expect(
      assertReferencesInOrganization(
        db(),
        { organizationId: ORG, orderId: ORDER },
        [{ kind: 'orderItem', ids: ITEM }],
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertReferencesInOrganization(
        db(),
        { organizationId: ORG, orderId: ORDER_2 },
        [{ kind: 'orderItem', ids: ITEM }],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      assertReferencesInOrganization(db(), { organizationId: OTHER_ORG }, [
        { kind: 'orderItem', ids: ITEM },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('referenceSql', () => {
  it('scopes organization tables directly and event tables through events', () => {
    expect(referenceSql('pfandType', false)).toContain(
      't.organization_id = $2',
    );
    expect(referenceSql('category', false)).toContain(
      'JOIN events p ON p.id = t.event_id',
    );
    expect(referenceSql('category', true)).toContain('t.event_id = $3');
    expect(referenceSql('orderItem', true)).toContain('t.order_id = $3');
    expect(referenceSql('event', false)).toContain('t.deleted_at IS NULL');
  });
});

describe('withoutForeignEvent', () => {
  it('keeps an event of the same organization', () => {
    const row = {
      organizationId: ORG,
      eventId: EVENT,
      event: { id: EVENT, organizationId: ORG },
    };
    expect(withoutForeignEvent(row)).toBe(row);
  });

  it('drops an event of another organization from the response', () => {
    const row = {
      organizationId: ORG,
      eventId: OTHER_EVENT,
      event: { id: OTHER_EVENT, organizationId: OTHER_ORG },
    };
    expect(withoutForeignEvent(row)).toEqual({
      organizationId: ORG,
      eventId: null,
      event: null,
    });
    expect(row.eventId).toBe(OTHER_EVENT);
  });
});
