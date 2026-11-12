import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import type { QrCode, User, UserOrganization } from '../../database/entities';
import { QrCodeType } from '../../database/entities/qr-code.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorReasons } from '../../common/constants/error-codes';
import { fakeReferenceDb } from '../../common/utils/organization-references.fake-spec';
import { QrCodesService } from './qr-codes.service';

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const EVENT = '10000000-0000-4000-8000-000000000001';
const OTHER_EVENT = '10000000-0000-4000-8000-000000000002';
const user = { id: 'user-1' } as User;

function setup(stored: Partial<QrCode>[] = []) {
  const save = jest.fn((row: unknown) => Promise.resolve(row));
  const repository = {
    create: (row: object) => ({ id: 'qr-1', ...row }),
    save,
    findAndCount: jest.fn(() => Promise.resolve([stored, stored.length])),
    manager: fakeReferenceDb({
      events: [
        { id: EVENT, organization_id: ORG },
        { id: OTHER_EVENT, organization_id: OTHER_ORG },
      ],
    }),
  } as unknown as Repository<QrCode>;
  const memberships = {
    findOne: jest.fn(() =>
      Promise.resolve({ role: OrganizationRole.ADMIN, permissions: {} }),
    ),
  } as unknown as Repository<UserOrganization>;
  return { service: new QrCodesService(repository, memberships), save };
}

describe('QR code references', () => {
  it('links a QR code to an event of the same organization', async () => {
    const { service, save } = setup();
    await service.create(
      ORG,
      { type: QrCodeType.TABLE, eventId: EVENT, tableNumber: '1' },
      user,
    );
    expect(save).toHaveBeenCalled();
  });

  it('rejects an event of another organization', async () => {
    const { service, save } = setup();
    await expect(
      service.create(
        ORG,
        { type: QrCodeType.TABLE, eventId: OTHER_EVENT },
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.EVENT_NOT_FOUND },
    });
    await expect(
      service.bulkCreate(
        ORG,
        { type: QrCodeType.TABLE, eventId: OTHER_EVENT, count: 2 },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('lists QR codes without events of another organization', async () => {
    const { service } = setup([
      {
        id: 'qr-1',
        organizationId: ORG,
        eventId: OTHER_EVENT,
        event: { id: OTHER_EVENT, organizationId: OTHER_ORG } as never,
      },
    ]);
    const page = await service.findAll(ORG, user, {
      page: 1,
      limit: 50,
    } as never);
    expect(page.data[0]).toMatchObject({ eventId: null, event: null });
  });
});
