import { Logger } from '@nestjs/common';
import { DevicesService } from './devices.service';
import {
  DeviceStatus,
  DeviceType,
} from '../../database/entities/device.entity';
import type { User } from '../../database/entities';

/**
 * Blocking, deleting, signing out or re-keying a device ends its open
 * live connections, whatever the device type.
 */
const ORG = 'org-1';
const user = { id: 'user-1', email: 'admin@example.org' } as User;

function setup(type: DeviceType = DeviceType.POS) {
  const device = {
    id: 'dev-1',
    name: 'Kasse',
    type,
    status: DeviceStatus.VERIFIED,
    isActive: true,
    organizationId: ORG,
    deviceToken: 'dev_old',
  };
  const repository = {
    save: jest.fn((d: unknown) => Promise.resolve(d)),
    remove: jest.fn(() => Promise.resolve()),
    findOne: jest.fn(() => Promise.resolve(device)),
  };
  const gateway = {
    disconnectDevice: jest.fn(),
    reassignDeviceRoom: jest.fn(),
    notifyDeviceStatusChanged: jest.fn(),
  };
  const agents = {
    markAgentOffline: jest.fn(() => Promise.resolve()),
    removeAgentDevice: jest.fn(() => Promise.resolve()),
  };
  const sessions = { endForDevice: jest.fn(() => Promise.resolve(0)) };
  const none = undefined as never;
  const service = new DevicesService(
    repository as never,
    none,
    none,
    none,
    none,
    gateway as never,
    agents as never,
    none,
    sessions as never,
  );
  const internals = service as unknown as {
    checkPermission: () => Promise<void>;
    findOne: () => Promise<typeof device>;
  };
  jest.spyOn(internals, 'checkPermission').mockResolvedValue(undefined);
  jest.spyOn(internals, 'findOne').mockResolvedValue(device);
  return { service, device, gateway };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('DevicesService ends live connections', () => {
  it.each([DeviceType.POS, DeviceType.DISPLAY, DeviceType.PRINTER_AGENT])(
    'when a %s device is blocked',
    async (type) => {
      const { service, gateway } = setup(type);
      await service.blockDevice(ORG, 'dev-1', user);
      expect(gateway.disconnectDevice).toHaveBeenCalledWith('dev-1');
    },
  );

  it('when a device is deleted', async () => {
    const { service, gateway } = setup();
    await service.remove(ORG, 'dev-1', user);
    expect(gateway.disconnectDevice).toHaveBeenCalledWith('dev-1');
  });

  it('when a device gets a new token', async () => {
    const { service, gateway, device } = setup();
    await service.regenerateToken(ORG, 'dev-1', user);
    expect(device.deviceToken).not.toBe('dev_old');
    expect(gateway.disconnectDevice).toHaveBeenCalledWith('dev-1');
  });

  it('when a device signs out', async () => {
    const { service, gateway } = setup();
    await service.logoutDevice('dev_old');
    expect(gateway.disconnectDevice).toHaveBeenCalledWith('dev-1');
  });
});
