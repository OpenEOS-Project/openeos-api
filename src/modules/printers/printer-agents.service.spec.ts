import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrinterAgentsService } from './printer-agents.service';
import { PrintersService } from './printers.service';
import {
  DeviceType,
  DeviceStatus,
} from '../../database/entities/device.entity';
import { PrinterConnectionType } from '../../database/entities/printer.entity';
import { PrinterType } from '../../database/entities/printer.entity';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = 'org-1';
const DEVICE = 'dev-1';
const USER = { id: 'user-1' } as never;

function repo(overrides: Record<string, unknown> = {}) {
  return {
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function agent(organizationId = ORG) {
  return {
    id: DEVICE,
    organizationId,
    name: 'Pi Küche',
    type: DeviceType.PRINTER_AGENT,
    status: DeviceStatus.VERIFIED,
    lastSeenAt: null,
    agentInfo: null,
  };
}

function setup() {
  const deviceRepository = repo({
    // Org-scoped lookup like the real repository: only the matching org
    // sees the agent.
    findOne: jest.fn(
      ({ where }: { where: { id: string; organizationId?: string } }) =>
        Promise.resolve(
          where.id === DEVICE &&
            (!where.organizationId || where.organizationId === ORG)
            ? agent()
            : null,
        ),
    ),
  });
  const discoveredRepository = repo();
  const printerRepository = repo();
  const userOrganizationRepository = repo({
    findOne: jest.fn(() =>
      Promise.resolve({ role: OrganizationRole.ADMIN, permissions: {} }),
    ),
  });
  const gatewayService = {
    notifyPrinterStatusChanged: jest.fn(),
    notifyPrinterConfigUpdate: jest.fn(),
    sendPrinterDiscover: jest.fn(),
    reassignDeviceRoom: jest.fn(),
    isDeviceOnline: jest.fn(() => Promise.resolve(true)),
    getOnlineDeviceIds: jest.fn(() => Promise.resolve([DEVICE])),
  };
  const printersService = {
    clearPrinterReferences: jest.fn(() => Promise.resolve()),
  };
  const service = new PrinterAgentsService(
    deviceRepository as never,
    discoveredRepository as never,
    printerRepository as never,
    userOrganizationRepository as never,
    gatewayService as never,
    printersService as unknown as PrintersService,
  );
  return {
    service,
    deviceRepository,
    discoveredRepository,
    printerRepository,
    userOrganizationRepository,
    gatewayService,
    printersService,
  };
}

describe('PrinterAgentsService.reportDiscovered', () => {
  const usbInput = {
    fingerprint: 'usb:04b8:0202:ABC',
    connectionType: PrinterConnectionType.USB,
    displayName: 'EPSON TM-T88V',
    details: { usbVendorId: '04b8', usbProductId: '0202', serialNumber: 'ABC' },
    discoveredVia: 'usb' as const,
  };
  const netInput = {
    fingerprint: 'net:aa:bb:cc:dd:ee:ff',
    connectionType: PrinterConnectionType.NETWORK,
    displayName: 'Star TSP143',
    details: { ipAddress: '192.168.1.50', macAddress: 'aa:bb:cc:dd:ee:ff' },
    discoveredVia: 'mdns' as const,
  };

  it('updates known entries, creates new ones and never deletes on a full scan', async () => {
    const { service, discoveredRepository, printerRepository } = setup();
    const old = new Date('2026-10-01T10:00:00Z');
    const existing = {
      id: 'd-usb',
      deviceId: DEVICE,
      organizationId: ORG,
      fingerprint: usbInput.fingerprint,
      connectionType: PrinterConnectionType.USB,
      displayName: 'alter Name',
      details: {},
      discoveredVia: 'usb',
      firstSeenAt: old,
      lastSeenAt: old,
      printerId: null,
    };
    discoveredRepository.find.mockResolvedValue([existing] as never);
    // The network printer was adopted before (e.g. agent reinstalled): the
    // fresh discovery row has to point at the existing printer again.
    printerRepository.find.mockResolvedValue([
      { id: 'p-net', fingerprint: netInput.fingerprint },
    ] as never);
    discoveredRepository.save.mockImplementation((rows: unknown[]) =>
      Promise.resolve(
        rows.map((r, i) => ({
          id: (r as { id?: string }).id ?? `new-${i}`,
          ...(r as object),
        })),
      ),
    );

    const result = await service.reportDiscovered(DEVICE, ORG, {
      printers: [usbInput, netInput],
      full: true,
    });

    expect(discoveredRepository.delete).not.toHaveBeenCalled();
    const saved = discoveredRepository.save.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(saved).toHaveLength(2);

    const usb = saved.find((r) => r.fingerprint === usbInput.fingerprint)!;
    expect(usb.id).toBe('d-usb');
    expect(usb.displayName).toBe('EPSON TM-T88V');
    expect(usb.details).toEqual(usbInput.details);
    expect(usb.firstSeenAt).toEqual(old);
    expect((usb.lastSeenAt as Date).getTime()).toBeGreaterThan(old.getTime());

    const net = saved.find((r) => r.fingerprint === netInput.fingerprint)!;
    expect(net).toMatchObject({
      deviceId: DEVICE,
      organizationId: ORG,
      connectionType: 'network',
      discoveredVia: 'mdns',
      printerId: 'p-net',
    });
    expect(net.firstSeenAt).toEqual(net.lastSeenAt);

    expect(result).toEqual([
      { id: 'd-usb', fingerprint: usbInput.fingerprint, printerId: null },
      { id: 'new-1', fingerprint: netInput.fingerprint, printerId: 'p-net' },
    ]);
  });

  it('collapses duplicate fingerprints in one report (last wins)', async () => {
    const { service, discoveredRepository } = setup();
    await service.reportDiscovered(DEVICE, ORG, {
      printers: [usbInput, { ...usbInput, displayName: 'zweiter' }],
      full: false,
    });
    const saved = discoveredRepository.save.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(saved).toHaveLength(1);
    expect(saved[0].displayName).toBe('zweiter');
  });

  it('is a no-op for an empty report', async () => {
    const { service, discoveredRepository } = setup();
    await expect(
      service.reportDiscovered(DEVICE, ORG, { printers: [], full: true }),
    ).resolves.toEqual([]);
    expect(discoveredRepository.save).not.toHaveBeenCalled();
  });
});

describe('PrinterAgentsService.handleAgentHeartbeat', () => {
  it('stores agent info and flips printer online flags by fingerprint', async () => {
    const { service, deviceRepository, printerRepository, gatewayService } =
      setup();
    printerRepository.find.mockResolvedValue([
      { id: 'p1', fingerprint: 'usb:1', isOnline: false },
      { id: 'p2', fingerprint: 'net:2', isOnline: true },
    ] as never);

    await service.handleAgentHeartbeat(DEVICE, ORG, {
      version: '2.0.0',
      os: 'linux',
      arch: 'aarch64',
      hostname: 'pi-kueche',
      pythonVersion: '3.12.1',
      capabilities: { usb: true, mdns: true, portscan: true, spooler: false },
      printers: [
        { fingerprint: 'usb:1', online: true },
        { fingerprint: 'net:2', online: true },
        { fingerprint: 'win:unknown', online: false },
      ],
    });

    expect(deviceRepository.update).toHaveBeenCalledWith(
      { id: DEVICE },
      expect.objectContaining({
        agentInfo: {
          version: '2.0.0',
          os: 'linux',
          arch: 'aarch64',
          hostname: 'pi-kueche',
          pythonVersion: '3.12.1',
          capabilities: {
            usb: true,
            mdns: true,
            portscan: true,
            spooler: false,
          },
        },
        lastSeenAt: expect.any(Date) as unknown,
      }),
    );
    // Only the agent's own printers, scoped to its organization.
    expect(printerRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deviceId: DEVICE,
          organizationId: ORG,
        }) as unknown,
      }),
    );
    expect(printerRepository.update).toHaveBeenCalledTimes(2);
    expect(printerRepository.update).toHaveBeenCalledWith(
      { id: 'p1' },
      expect.objectContaining({ isOnline: true }),
    );
    // p1 flipped offline → online, p2 stayed online: one notification.
    expect(gatewayService.notifyPrinterStatusChanged).toHaveBeenCalledTimes(1);
    expect(gatewayService.notifyPrinterStatusChanged).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ printerId: 'p1', isOnline: true }),
    );
  });

  it('reports a printer going offline', async () => {
    const { service, printerRepository, gatewayService } = setup();
    printerRepository.find.mockResolvedValue([
      { id: 'p1', fingerprint: 'usb:1', isOnline: true },
    ] as never);

    await service.handleAgentHeartbeat(DEVICE, ORG, {
      printers: [
        { fingerprint: 'usb:1', online: false, lastError: 'unplugged' },
      ],
    });

    expect(printerRepository.update).toHaveBeenCalledWith(
      { id: 'p1' },
      expect.objectContaining({ isOnline: false }),
    );
    expect(gatewayService.notifyPrinterStatusChanged).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ printerId: 'p1', isOnline: false }),
    );
  });

  it('only touches the device when no printers are reported', async () => {
    const { service, deviceRepository, printerRepository } = setup();
    await service.handleAgentHeartbeat(DEVICE, ORG, { version: '2.0.0' });
    expect(deviceRepository.update).toHaveBeenCalled();
    expect(printerRepository.find).not.toHaveBeenCalled();
  });
});

describe('PrinterAgentsService.adopt', () => {
  const discovered = {
    id: 'disc-1',
    deviceId: DEVICE,
    organizationId: ORG,
    fingerprint: 'net:192.168.1.50',
    connectionType: PrinterConnectionType.NETWORK,
    displayName: 'Star TSP143',
    details: { ipAddress: '192.168.1.50' },
    discoveredVia: 'portscan',
    printerId: null as string | null,
  };
  const dto = {
    name: 'Küche',
    type: PrinterType.KITCHEN,
    paperWidth: 80,
    hasCashDrawer: false,
  };

  it('creates the printer from the details, links it and notifies the agent', async () => {
    const { service, discoveredRepository, printerRepository, gatewayService } =
      setup();
    discoveredRepository.findOne.mockResolvedValue({ ...discovered } as never);
    printerRepository.save.mockImplementation((p: object) =>
      Promise.resolve({ id: 'p-new', ...p }),
    );

    const printer = await service.adopt(ORG, DEVICE, 'disc-1', dto, USER);

    expect(printerRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        deviceId: DEVICE,
        name: 'Küche',
        type: 'kitchen',
        connectionType: 'network',
        connectionConfig: { ipAddress: '192.168.1.50', port: 9100 },
        fingerprint: 'net:192.168.1.50',
        paperWidth: 80,
        hasCashDrawer: false,
        isActive: true,
      }),
    );
    expect(printer.id).toBe('p-new');
    expect(discoveredRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'disc-1', printerId: 'p-new' }),
    );
    expect(gatewayService.notifyPrinterConfigUpdate).toHaveBeenCalledWith(
      ORG,
      DEVICE,
    );
  });

  it('maps USB and Windows details into the connection config', async () => {
    const { service, discoveredRepository, printerRepository } = setup();
    discoveredRepository.findOne
      .mockResolvedValueOnce({
        ...discovered,
        connectionType: PrinterConnectionType.USB,
        fingerprint: 'usb:04b8:0202:ABC',
        details: {
          usbVendorId: '04b8',
          usbProductId: '0202',
          serialNumber: 'ABC',
        },
      } as never)
      .mockResolvedValueOnce({
        ...discovered,
        connectionType: PrinterConnectionType.WINDOWS,
        fingerprint: 'win:Bon',
        details: {
          windowsPrinterName: 'Bon',
          driverName: 'Generic / Text Only',
        },
      } as never);

    await service.adopt(ORG, DEVICE, 'disc-1', dto, USER);
    await service.adopt(ORG, DEVICE, 'disc-1', dto, USER);

    expect(printerRepository.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionType: 'usb',
        connectionConfig: {
          usbVendorId: '04b8',
          usbProductId: '0202',
          usbSerialNumber: 'ABC',
        },
      }),
    );
    expect(printerRepository.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectionType: 'windows',
        connectionConfig: { windowsPrinterName: 'Bon' },
      }),
    );
  });

  it('answers 409 PRINTER_ALREADY_ADOPTED when the printer still exists', async () => {
    const { service, discoveredRepository, printerRepository, gatewayService } =
      setup();
    discoveredRepository.findOne.mockResolvedValue({
      ...discovered,
      printerId: 'p-old',
    } as never);
    printerRepository.findOne.mockResolvedValue({ id: 'p-old' } as never);

    await expect(
      service.adopt(ORG, DEVICE, 'disc-1', dto, USER),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: {
        code: ErrorCodes.PRINTER_ALREADY_ADOPTED,
        params: { printerId: 'p-old' },
      },
    });
    expect(printerRepository.create).not.toHaveBeenCalled();
    expect(gatewayService.notifyPrinterConfigUpdate).not.toHaveBeenCalled();
  });

  it('re-adopts when the previously linked printer was deleted', async () => {
    const { service, discoveredRepository, printerRepository } = setup();
    discoveredRepository.findOne.mockResolvedValue({
      ...discovered,
      printerId: 'p-gone',
    } as never);
    printerRepository.findOne.mockResolvedValue(null);
    printerRepository.save.mockImplementation((p: object) =>
      Promise.resolve({ id: 'p-new', ...p }),
    );

    await expect(
      service.adopt(ORG, DEVICE, 'disc-1', dto, USER),
    ).resolves.toMatchObject({ id: 'p-new' });
  });

  it('rejects an agent of another organization with 404', async () => {
    const { service, discoveredRepository } = setup();
    discoveredRepository.findOne.mockResolvedValue({ ...discovered } as never);

    await expect(
      service.adopt('org-2', DEVICE, 'disc-1', dto, USER),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { reason: ErrorReasons.PRINTER_AGENT_NOT_FOUND },
    });
    expect(discoveredRepository.save).not.toHaveBeenCalled();
  });
});

describe('PrinterAgentsService.removeAgent', () => {
  it('clears references, drops the printers and the device, and kicks the socket', async () => {
    const {
      service,
      printerRepository,
      deviceRepository,
      printersService,
      gatewayService,
    } = setup();
    printerRepository.find.mockResolvedValue([
      { id: 'p1' },
      { id: 'p2' },
    ] as never);

    await service.removeAgent(ORG, DEVICE, USER);

    expect(printersService.clearPrinterReferences).toHaveBeenCalledWith(ORG, [
      'p1',
      'p2',
    ]);
    expect(printerRepository.delete).toHaveBeenCalledTimes(1);
    expect(deviceRepository.delete).toHaveBeenCalledWith({ id: DEVICE });
    expect(gatewayService.reassignDeviceRoom).toHaveBeenCalledWith(
      DEVICE,
      null,
    );
    // Order matters: references first, then printers, then the device.
    const order = [
      printersService.clearPrinterReferences.mock.invocationCallOrder[0],
      printerRepository.delete.mock.invocationCallOrder[0],
      deviceRepository.delete.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('skips the cleanup when the agent has no printers', async () => {
    const { service, printerRepository, deviceRepository, printersService } =
      setup();
    await service.removeAgent(ORG, DEVICE, USER);
    expect(printersService.clearPrinterReferences).not.toHaveBeenCalled();
    expect(printerRepository.delete).not.toHaveBeenCalled();
    expect(deviceRepository.delete).toHaveBeenCalledWith({ id: DEVICE });
  });

  it('refuses non-admins without the devices permission', async () => {
    const { service, userOrganizationRepository, deviceRepository } = setup();
    userOrganizationRepository.findOne.mockResolvedValue({
      role: OrganizationRole.MEMBER,
      permissions: { products: true },
    } as never);
    await expect(service.removeAgent(ORG, DEVICE, USER)).rejects.toMatchObject({
      response: { reason: ErrorReasons.INSUFFICIENT_PERMISSIONS },
    });
    expect(deviceRepository.delete).not.toHaveBeenCalled();
  });
});

describe('PrinterAgentsService.requestDiscovery', () => {
  it('emits printerDiscover to the agent', async () => {
    const { service, gatewayService } = setup();
    await expect(
      service.requestDiscovery(ORG, DEVICE, { subnetScan: true }, USER),
    ).resolves.toEqual({ deviceId: DEVICE, subnetScan: true });
    expect(gatewayService.sendPrinterDiscover).toHaveBeenCalledWith(
      ORG,
      DEVICE,
      {
        subnetScan: true,
      },
    );
  });

  it('answers 409 PRINTER_AGENT_OFFLINE when the agent is not connected', async () => {
    const { service, gatewayService } = setup();
    gatewayService.isDeviceOnline.mockResolvedValue(false);
    await expect(
      service.requestDiscovery(ORG, DEVICE, {}, USER),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { code: ErrorCodes.PRINTER_AGENT_OFFLINE },
    });
    expect(gatewayService.sendPrinterDiscover).not.toHaveBeenCalled();
  });
});

describe('PrinterAgentsService.listAgents', () => {
  it('returns one entry per agent with online flag and counts', async () => {
    const {
      service,
      deviceRepository,
      discoveredRepository,
      printerRepository,
    } = setup();
    deviceRepository.find.mockResolvedValue([
      { ...agent(), agentInfo: { version: '2.0.0', os: 'windows' } },
      { ...agent(), id: 'dev-2', name: 'Theke' },
    ] as never);
    const qb = (rows: Array<{ deviceId: string; count: string }>) => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => Promise.resolve(rows)),
    });
    discoveredRepository.createQueryBuilder = jest.fn(() =>
      qb([{ deviceId: DEVICE, count: '3' }]),
    );
    printerRepository.createQueryBuilder = jest.fn(() =>
      qb([{ deviceId: DEVICE, count: '1' }]),
    );

    const list = await service.listAgents(ORG, USER);

    expect(list).toEqual([
      {
        deviceId: DEVICE,
        name: 'Pi Küche',
        status: 'verified',
        isOnline: true,
        lastSeenAt: null,
        agentInfo: { version: '2.0.0', os: 'windows' },
        discoveredCount: 3,
        printerCount: 1,
      },
      {
        deviceId: 'dev-2',
        name: 'Theke',
        status: 'verified',
        isOnline: false,
        lastSeenAt: null,
        agentInfo: null,
        discoveredCount: 0,
        printerCount: 0,
      },
    ]);
  });
});
