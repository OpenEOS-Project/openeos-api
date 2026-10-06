import { PrintersService } from './printers.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

function setup(current: { id: string; isOnline: boolean } | null) {
  const printerRepository = {
    findOne: jest.fn(() => Promise.resolve(current)),
    update: jest.fn(() => Promise.resolve({ affected: current ? 1 : 0 })),
  };
  const gatewayService = { notifyPrinterStatusChanged: jest.fn() };
  const none = undefined as never;
  const service = new PrintersService(
    printerRepository as never,
    none,
    none,
    gatewayService as never,
  );
  return { service, printerRepository, gatewayService };
}

describe('PrintersService.updateOnlineStatus', () => {
  it('emits printerStatusChanged when the state flips', async () => {
    const { service, printerRepository, gatewayService } = setup({
      id: 'p1',
      isOnline: false,
    });

    await service.updateOnlineStatus('p1', true, 'org-1');

    expect(printerRepository.update).toHaveBeenCalledWith(
      { id: 'p1', organizationId: 'org-1' },
      expect.objectContaining({ isOnline: true }),
    );
    expect(gatewayService.notifyPrinterStatusChanged).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ printerId: 'p1', isOnline: true }),
    );
  });

  it('only refreshes last_seen_at on a plain heartbeat', async () => {
    const { service, printerRepository, gatewayService } = setup({
      id: 'p1',
      isOnline: true,
    });

    await service.updateOnlineStatus('p1', true, 'org-1');

    expect(printerRepository.update).toHaveBeenCalled();
    expect(gatewayService.notifyPrinterStatusChanged).not.toHaveBeenCalled();
  });

  it('ignores printers of other organizations', async () => {
    const { service, printerRepository, gatewayService } = setup(null);

    await service.updateOnlineStatus('p1', false, 'org-2');

    expect(printerRepository.update).not.toHaveBeenCalled();
    expect(gatewayService.notifyPrinterStatusChanged).not.toHaveBeenCalled();
  });
});
