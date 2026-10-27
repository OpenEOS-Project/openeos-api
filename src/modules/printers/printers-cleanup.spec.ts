import { PrintersService } from './printers.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/**
 * Wird ein Drucker (oder ein ganzer Agent) entfernt, duerfen Stationen,
 * Bon-Workflow, Geraete-Einstellungen und Druckeinstellungen nicht mehr auf
 * ihn zeigen.
 */
describe('PrintersService.clearPrinterReferences', () => {
  function setup() {
    const organization = {
      id: 'org-1',
      settings: {
        vatExempt: false,
        orderFlow: {
          receiptPrinting: {
            enabled: true,
            trigger: 'payment_received',
            printerId: 'p-gone',
            templateId: null,
          },
          kitchenTicketPrinting: {
            enabled: true,
            printerId: 'p-keep',
            templateId: null,
            mode: 'per_station',
          },
          orderTicketPrinting: {
            enabled: false,
            printerId: 'p-gone',
            templateId: null,
          },
          kitchenDisplay: { enabled: true },
        },
      },
    };
    const devices = [
      {
        id: 'pos-1',
        settings: { defaultPrinterId: 'p-gone', soundEnabled: true },
      },
      {
        id: 'pos-2',
        settings: { defaultPrinterId: 'p-keep', cashDrawerPrinterId: 'p-gone' },
      },
      { id: 'pos-3', settings: { soundEnabled: false } },
    ];
    const query = jest.fn((_sql: string, _params: unknown[]) =>
      Promise.resolve([] as unknown[]),
    );
    const printerRepository = { manager: { query } };
    const organizationRepository = {
      findOne: jest.fn(() => Promise.resolve(organization)),
      save: jest.fn((o: unknown) => Promise.resolve(o)),
    };
    const deviceRepository = {
      find: jest.fn(() => Promise.resolve(devices)),
      save: jest.fn((d: unknown) => Promise.resolve(d)),
    };
    const productionStationRepository = {
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const gatewayService = {
      notifyOrganizationSettingsUpdated: jest.fn(),
      notifyDeviceSettingsUpdated: jest.fn(),
    };
    const none = undefined as never;
    const service = new PrintersService(
      printerRepository as never,
      none,
      deviceRepository as never,
      gatewayService as never,
      organizationRepository as never,
      productionStationRepository as never,
    );
    return {
      service,
      organization,
      organizationRepository,
      deviceRepository,
      productionStationRepository,
      gatewayService,
      query,
    };
  }

  it('nulls stations, order flow, device settings and print settings', async () => {
    const s = setup();

    await s.service.clearPrinterReferences('org-1', ['p-gone']);

    expect(s.productionStationRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({ printerId: expect.anything() as unknown }),
      { printerId: null },
    );

    const savedOrg = s.organizationRepository.save.mock
      .calls[0][0] as typeof s.organization;
    expect(savedOrg.settings.orderFlow.receiptPrinting.printerId).toBeNull();
    expect(
      savedOrg.settings.orderFlow.orderTicketPrinting.printerId,
    ).toBeNull();
    expect(savedOrg.settings.orderFlow.kitchenTicketPrinting).toEqual({
      enabled: true,
      printerId: 'p-keep',
      templateId: null,
      mode: 'per_station',
    });
    expect(savedOrg.settings.orderFlow.kitchenDisplay).toEqual({
      enabled: true,
    });
    expect(
      s.gatewayService.notifyOrganizationSettingsUpdated,
    ).toHaveBeenCalledWith('org-1');

    const savedDevices = s.deviceRepository.save.mock.calls.map(
      (c) => c[0] as { id: string; settings: Record<string, unknown> },
    );
    expect(savedDevices.map((d) => d.id)).toEqual(['pos-1', 'pos-2']);
    expect(savedDevices[0].settings).toEqual({ soundEnabled: true });
    expect(savedDevices[1].settings).toEqual({ defaultPrinterId: 'p-keep' });
    expect(s.gatewayService.notifyDeviceSettingsUpdated).toHaveBeenCalledTimes(
      2,
    );

    expect(s.query).toHaveBeenCalledTimes(2);
    expect(s.query.mock.calls[0][0]).toContain('"categories"');
    expect(s.query.mock.calls[1][0]).toContain('"products"');
    expect(s.query.mock.calls[0][1]).toEqual([['p-gone']]);
  });

  it('leaves everything alone when nothing references the printers', async () => {
    const s = setup();
    await s.service.clearPrinterReferences('org-1', ['p-unrelated']);
    expect(s.organizationRepository.save).not.toHaveBeenCalled();
    expect(s.deviceRepository.save).not.toHaveBeenCalled();
    expect(
      s.gatewayService.notifyOrganizationSettingsUpdated,
    ).not.toHaveBeenCalled();
  });

  it('does nothing for an empty list', async () => {
    const s = setup();
    await s.service.clearPrinterReferences('org-1', []);
    expect(s.productionStationRepository.update).not.toHaveBeenCalled();
    expect(s.organizationRepository.findOne).not.toHaveBeenCalled();
  });
});
