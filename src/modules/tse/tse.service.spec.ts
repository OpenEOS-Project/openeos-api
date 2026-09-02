import { ForbiddenException } from '@nestjs/common';
import { TseService } from './tse.service';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { NullTseProvider } from './providers/null-tse.provider';

describe('TseService', () => {
  let organizationRepository: { findOne: jest.Mock };
  let deviceRepository: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let userOrganizationRepository: { findOne: jest.Mock };
  let fiskalyProvider: jest.Mocked<Pick<FiskalyTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection'>>;
  let nullProvider: jest.Mocked<Pick<NullTseProvider, 'ensureClient' | 'recordTransaction' | 'testConnection'>>;
  let service: TseService;

  beforeEach(() => {
    organizationRepository = { findOne: jest.fn() };
    deviceRepository = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    userOrganizationRepository = { findOne: jest.fn() };
    fiskalyProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
    };
    nullProvider = {
      ensureClient: jest.fn(),
      recordTransaction: jest.fn(),
      testConnection: jest.fn(),
    };

    // Attach `name` in place (rather than spreading into a new object) so
    // later mutations in a test are visible through the same reference the
    // service was constructed with.
    (fiskalyProvider as any).name = 'fiskaly';
    (nullProvider as any).name = 'none';

    service = new TseService(
      organizationRepository as any,
      deviceRepository as any,
      userOrganizationRepository as any,
      fiskalyProvider as any,
      nullProvider as any,
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

    it('returns null when provider is none', async () => {
      organizationRepository.findOne.mockResolvedValue({
        id: ORG_ID,
        settings: { tse: { enabled: true, provider: 'none' } },
      });

      const result = await service.recordTransaction(ORG_ID, null, { amount: 10, paymentMethod: 'cash' });

      expect(result).toBeNull();
      expect(fiskalyProvider.recordTransaction).not.toHaveBeenCalled();
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
});
