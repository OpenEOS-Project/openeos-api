import { GoneException } from '@nestjs/common';
import { DeviceApiController } from './device-api.controller';
import { ErrorCodes } from '../../common/constants/error-codes';
import { DeviceType } from '../../database/entities/device.entity';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

function controller(overrides: {
  printersService?: unknown;
  printerAgentsService?: unknown;
}) {
  const none = undefined as never;
  const args = new Array<never>(26).fill(none);
  args[13] = (overrides.printersService ?? none) as never;
  args[25] = (overrides.printerAgentsService ?? none) as never;
  return new DeviceApiController(
    ...(args as unknown as ConstructorParameters<typeof DeviceApiController>),
  );
}

const agent = {
  id: 'dev-1',
  organizationId: 'org-1',
  type: DeviceType.PRINTER_AGENT,
} as never;

describe('DeviceApiController printers', () => {
  it('answers 410 PRINTER_SYNC_REMOVED on the removed sync endpoint', () => {
    const c = controller({});
    expect(() => c.syncPrinters()).toThrow(GoneException);
    try {
      c.syncPrinters();
    } catch (error) {
      expect((error as GoneException).getResponse()).toMatchObject({
        code: ErrorCodes.PRINTER_SYNC_REMOVED,
        reason: ErrorCodes.PRINTER_SYNC_REMOVED,
      });
    }
  });

  it('lists only adopted printers of the agent including the fingerprint', async () => {
    const printersService = {
      findByDeviceId: jest.fn(() =>
        Promise.resolve([
          {
            id: 'p1',
            name: 'Küche',
            type: 'kitchen',
            fingerprint: 'usb:04b8:0202:ABC',
            connectionType: 'usb',
            connectionConfig: { usbVendorId: '04b8', usbProductId: '0202' },
            paperWidth: 80,
            hasCashDrawer: false,
            isActive: true,
            isOnline: true,
            organizationId: 'org-1',
            deviceId: 'dev-1',
          },
        ]),
      ),
    };
    const c = controller({ printersService });
    await expect(c.getPrinters(agent)).resolves.toEqual({
      data: {
        printers: [
          {
            id: 'p1',
            name: 'Küche',
            type: 'kitchen',
            fingerprint: 'usb:04b8:0202:ABC',
            connectionType: 'usb',
            connectionConfig: { usbVendorId: '04b8', usbProductId: '0202' },
            paperWidth: 80,
            hasCashDrawer: false,
            isActive: true,
          },
        ],
      },
    });
    expect(printersService.findByDeviceId).toHaveBeenCalledWith('dev-1');
  });

  it('forwards discovered printers to the agents service', async () => {
    const printerAgentsService = {
      reportDiscovered: jest.fn(() =>
        Promise.resolve([{ id: 'd1', fingerprint: 'usb:1', printerId: null }]),
      ),
    };
    const c = controller({ printerAgentsService });
    const body = {
      full: true,
      printers: [
        {
          fingerprint: 'usb:1',
          connectionType: 'usb',
          displayName: 'EPSON',
          details: {},
          discoveredVia: 'usb',
        },
      ],
    } as never;
    await expect(c.reportDiscoveredPrinters(agent, body)).resolves.toEqual({
      data: { printers: [{ id: 'd1', fingerprint: 'usb:1', printerId: null }] },
    });
    expect(printerAgentsService.reportDiscovered).toHaveBeenCalledWith(
      'dev-1',
      'org-1',
      body,
    );
  });

  it('rejects discovery reports from non-agent devices', async () => {
    const c = controller({});
    await expect(
      c.reportDiscoveredPrinters(
        { id: 'pos', organizationId: 'org-1', type: DeviceType.POS } as never,
        { full: true, printers: [] },
      ),
    ).rejects.toMatchObject({
      response: { reason: 'DEVICE_NOT_PRINTER_AGENT' },
    });
  });
});
