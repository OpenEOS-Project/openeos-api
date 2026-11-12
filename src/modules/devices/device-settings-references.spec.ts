import type { Repository } from 'typeorm';

import type { Device, User, UserOrganization } from '../../database/entities';
import { DeviceType } from '../../database/entities/device.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorReasons } from '../../common/constants/error-codes';
import { fakeReferenceDb } from '../../common/utils/organization-references.fake-spec';
import { DevicesService } from './devices.service';

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';
const DEVICE = '20000000-0000-4000-8000-000000000001';
const OWN_POS = '20000000-0000-4000-8000-000000000002';
const FOREIGN_POS = '20000000-0000-4000-8000-000000000003';
const OWN_PRINTER = '30000000-0000-4000-8000-000000000001';
const FOREIGN_PRINTER = '30000000-0000-4000-8000-000000000002';
const OWN_AREA = '60000000-0000-4000-8000-000000000001';
const FOREIGN_AREA = '60000000-0000-4000-8000-000000000002';
const user = { id: 'user-1' } as User;

function setup() {
  const stored = {
    id: DEVICE,
    organizationId: ORG,
    name: 'Kundenanzeige',
    type: DeviceType.DISPLAY,
    settings: {},
  } as unknown as Device;
  const save = jest.fn((row: unknown) => Promise.resolve(row));
  const manager = fakeReferenceDb({
    devices: [
      { id: DEVICE, organization_id: ORG },
      { id: OWN_POS, organization_id: ORG },
      { id: FOREIGN_POS, organization_id: OTHER_ORG },
    ],
    printers: [
      { id: OWN_PRINTER, organization_id: ORG },
      { id: FOREIGN_PRINTER, organization_id: OTHER_ORG },
    ],
    table_areas: [
      { id: OWN_AREA, organization_id: ORG },
      { id: FOREIGN_AREA, organization_id: OTHER_ORG },
    ],
  });
  const devices = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    create: (row: object) => ({ id: 'new-device', ...row }),
    save,
    manager,
  } as unknown as Repository<Device>;
  const memberships = {
    findOne: jest.fn(() =>
      Promise.resolve({ role: OrganizationRole.ADMIN, permissions: {} }),
    ),
  } as unknown as Repository<UserOrganization>;
  const gateway = {
    notifyDeviceSettingsUpdated: jest.fn(),
    notifyDeviceUpdated: jest.fn(),
    notifyDeviceConfigUpdate: jest.fn(),
  };
  const none = undefined as never;
  const service = new DevicesService(
    devices,
    memberships,
    none,
    none,
    none,
    gateway as never,
    none,
    none,
    { endForDevice: jest.fn(() => Promise.resolve(0)) } as never,
  );
  return { service, save };
}

describe('Device settings references', () => {
  it('accepts printers, area and mirrored till of the same organization', async () => {
    const { service, save } = setup();
    await service.update(
      ORG,
      DEVICE,
      {
        settings: {
          defaultPrinterId: OWN_PRINTER,
          tableAreaId: OWN_AREA,
          posDeviceId: OWN_POS,
        },
      },
      user,
    );
    expect(save).toHaveBeenCalled();
  });

  it.each([
    [{ defaultPrinterId: FOREIGN_PRINTER }, ErrorReasons.PRINTER_NOT_FOUND],
    [{ cashDrawerPrinterId: FOREIGN_PRINTER }, ErrorReasons.PRINTER_NOT_FOUND],
    [{ tableAreaId: FOREIGN_AREA }, ErrorReasons.TABLE_AREA_NOT_FOUND],
    [{ posDeviceId: FOREIGN_POS }, ErrorReasons.DEVICE_NOT_FOUND],
    [{ posDeviceId: DEVICE }, ErrorReasons.DEVICE_NOT_FOUND],
  ])('rejects %o', async (settings, reason) => {
    const { service, save } = setup();
    await expect(
      service.update(ORG, DEVICE, { settings } as never, user),
    ).rejects.toMatchObject({ response: { reason } });
    expect(save).not.toHaveBeenCalled();
  });

  it('checks the settings of a newly created device as well', async () => {
    const { service, save } = setup();
    await expect(
      service.create(
        ORG,
        {
          name: 'Kasse 2',
          type: DeviceType.POS,
          settings: { defaultPrinterId: FOREIGN_PRINTER },
        } as never,
        user,
      ),
    ).rejects.toMatchObject({
      response: { reason: ErrorReasons.PRINTER_NOT_FOUND },
    });
    expect(save).not.toHaveBeenCalled();
  });
});
