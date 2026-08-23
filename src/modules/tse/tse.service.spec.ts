import { ForbiddenException } from '@nestjs/common';
import { TseService } from './tse.service';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { LocalTseProvider } from './providers/local-tse.provider';

describe('TseService', () => {
  let organizationRepository: { findOne: jest.Mock };
  let deviceRepository: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let fiskalyProvider: jest.Mocked<Pick<FiskalyTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection' | 'exportData'>>;
  let localProvider: jest.Mocked<Pick<LocalTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection' | 'exportData'>>;
  let service: TseService;

  beforeEach(() => {
    organizationRepository = { findOne: jest.fn() };
    deviceRepository = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    userOrganizationRepository = { findOne: jest.fn() };
    fiskalyProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
      exportData: jest.fn(),
    };
    localProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
      exportData: jest.fn(),
    };

    // Attach `name` in place (rather than spreading into a new object) so
    // later mutations to fiskalyProvider/localProvider in a test — e.g.
    // deleting `exportData` to simulate an unsupported provider — are
    // visible through the same reference the service was constructed with.
    (fiskalyProvider as any).name = 'fiskaly';
    (localProvider as any).name = 'local';

    service = new TseService(
      organizationRepository as any,
      deviceRepository as any,
      userOrganizationRepository as any,
      fiskalyProvider as any,
      localProvider as any,
    );
  });

  const ORG_ID = 'org-1';
  const USER_ID = 'user-1';

  describe('recordTransaction', () => {
    it('returns null when TSE is not enabled', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: false, provider: 'fiskaly' } },
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
      expect(fiskalyProvider.recordTransaction).not.toHaveBeenCalled();
    });

    it('returns null when provider is fiskaly but credentials are missing', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly' } }, // no `fiskaly` block
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
    });

    it('signs through the fiskaly provider and returns failed: false on success', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          currency: 'EUR',
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: ORG_ID,
        transactionNumber: 5,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(fiskalyProvider.ensureClient).toHaveBeenCalledWith(
        { apiKey: 'k', apiSecret: 's', tssId: 't' },
        ORG_ID, // no device -> org-wide client id
      );
      expect(result).toEqual(expect.objectContaining({ failed: false, transactionNumber: 5, signatureValue: 'sig' }));
    });

    it('never throws on a provider failure — returns a failed:true outage marker instead', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.recordTransaction.mockRejectedValue(new Error('network down'));

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toEqual(
        expect.objectContaining({ failed: true, failureReason: 'network down', provider: 'fiskaly' }),
      );
    });

    it('uses the local provider when configured, passing organizationId through config', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'local', local: { agentDeviceId: 'agent-1' } } },
      });
      localProvider.recordTransaction.mockResolvedValue({
        provider: 'local',
        clientId: ORG_ID,
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(localProvider.recordTransaction).toHaveBeenCalledWith(
        { agentDeviceId: 'agent-1', organizationId: ORG_ID },
        expect.objectContaining({ organizationId: ORG_ID, clientId: ORG_ID }),
      );
    });
  });

  describe('resolveClientId (via recordTransaction)', () => {
    it("assigns and persists a till's own client id (its device id) on first use", async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      deviceRepository.findOne.mockResolvedValue({ id: 'device-1', settings: {} });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'device-1',
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, 'device-1', { amount: 10, paymentMethod: 'cash' });

      expect(deviceRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'device-1', settings: expect.objectContaining({ tseClientId: 'device-1' }) }),
      );
      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: 'device-1' }),
      );
    });

    it('reuses an already-assigned client id without writing again', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      deviceRepository.findOne.mockResolvedValue({ id: 'device-1', settings: { tseClientId: 'existing-client' } });
      fiskalyProvider.recordTransaction.mockResolvedValue({
        provider: 'fiskaly',
        clientId: 'existing-client',
        transactionNumber: 1,
        serialNumber: 'SN',
        signatureCounter: 1,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: 'qr',
      });

      await service.recordTransaction(ORG_ID, 'device-1', { amount: 10, paymentMethod: 'cash' });

      expect(deviceRepository.save).not.toHaveBeenCalled();
      expect(fiskalyProvider.recordTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: 'existing-client' }),
      );
    });
  });

  describe('testConnection', () => {
    it('throws ForbiddenException when the user is not a member of the org', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.testConnection(ORG_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('reports not-configured when TSE is off', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      organizationRepository.findOne.mockResolvedValue({ id: ORG_ID, settings: {} });

      const result = await service.testConnection(ORG_ID, USER_ID);

      expect(result.ok).toBe(false);
    });

    it('delegates to the resolved provider', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: {
          tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } },
        },
      });
      fiskalyProvider.testConnection.mockResolvedValue({ ok: true });

      const result = await service.testConnection(ORG_ID, USER_ID);

      expect(result).toEqual({ ok: true });
      expect(fiskalyProvider.testConnection).toHaveBeenCalledWith({ apiKey: 'k', apiSecret: 's', tssId: 't' });
    });
  });

  describe('listClientIds', () => {
    it('throws ForbiddenException for a non-member', async () => {
      userOrganizationRepository.findOne.mockResolvedValue(null);

      await expect(service.listClientIds(ORG_ID, USER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('returns the org-wide id plus each distinct device client id', async () => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
      deviceRepository.find.mockResolvedValue([
        { id: 'd1', settings: { tseClientId: 'client-a' } },
        { id: 'd2', settings: { tseClientId: 'client-b' } },
        { id: 'd3', settings: {} }, // never signed -> no client id yet
        { id: 'd4', settings: { tseClientId: 'client-a' } }, // duplicate
      ]);

      const result = await service.listClientIds(ORG_ID, USER_ID);

      expect(result).toEqual([ORG_ID, 'client-a', 'client-b']);
    });
  });

  describe('exportData', () => {
    beforeEach(() => {
      userOrganizationRepository.findOne.mockResolvedValue({ id: 'membership-1' });
    });

    it('throws when the provider does not support export', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      (fiskalyProvider as any).exportData = undefined;

      await expect(
        service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23')),
      ).rejects.toThrow('TSE-Export ist für diese Organisation nicht verfügbar');
    });

    it('rejects a clientId that does not belong to this org', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      deviceRepository.find.mockResolvedValue([{ id: 'd1', settings: { tseClientId: 'client-a' } }]);

      await expect(
        service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23'), 'not-my-client'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('defaults to the org-wide client id and returns the provider export', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'fiskaly', fiskaly: { apiKey: 'k', apiSecret: 's', tssId: 't' } } },
      });
      fiskalyProvider.exportData.mockResolvedValue({ data: Buffer.from('x'), filename: 'export.tar' });

      const result = await service.exportData(ORG_ID, USER_ID, new Date('2026-08-21'), new Date('2026-08-23'));

      expect(result.filename).toBe('export.tar');
      expect(fiskalyProvider.exportData).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ clientId: ORG_ID }),
      );
    });
  });
});
