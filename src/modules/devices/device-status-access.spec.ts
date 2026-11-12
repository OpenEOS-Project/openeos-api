import { ForbiddenException } from '@nestjs/common';

import { User } from '../../database/entities/user.entity';
import {
  OrganizationPermissions,
  OrganizationRole,
} from '../../database/entities/user-organization.entity';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const USER = { id: 'user-1', isSuperAdmin: false } as User;

function setup(
  membership: {
    role: OrganizationRole;
    permissions?: OrganizationPermissions;
  } | null,
) {
  const userOrganizationRepository = {
    findOne: jest.fn(() => Promise.resolve(membership)),
  };
  const none = undefined as never;
  const service = new DevicesService(
    none,
    userOrganizationRepository as never,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  const getOnlineDeviceIds = jest.fn(() => Promise.resolve(['device-1']));
  const controller = new DevicesController(service, {
    getOnlineDeviceIds,
  } as never);
  return { controller, getOnlineDeviceIds };
}

describe('online device ids', () => {
  it('are listed for admins', async () => {
    const { controller } = setup({ role: OrganizationRole.ADMIN });
    await expect(controller.getOnlineDeviceIds(ORG_ID, USER)).resolves.toEqual({
      data: ['device-1'],
    });
  });

  it('are listed for members with the devices permission', async () => {
    const { controller } = setup({
      role: OrganizationRole.MEMBER,
      permissions: { devices: true },
    });
    await expect(controller.getOnlineDeviceIds(ORG_ID, USER)).resolves.toEqual({
      data: ['device-1'],
    });
  });

  it('need the devices permission', async () => {
    const { controller, getOnlineDeviceIds } = setup({
      role: OrganizationRole.MEMBER,
      permissions: { products: true },
    });
    await expect(
      controller.getOnlineDeviceIds(ORG_ID, USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getOnlineDeviceIds).not.toHaveBeenCalled();
  });

  it('need a membership', async () => {
    const { controller } = setup(null);
    await expect(
      controller.getOnlineDeviceIds(ORG_ID, USER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
