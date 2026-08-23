import { LocalTseProvider } from './local-tse.provider';
import { GatewayService } from '../../gateway/gateway.service';
import { GatewayEvents } from '../../gateway/dto';

describe('LocalTseProvider', () => {
  let gatewayService: { sendTseJobToAgent: jest.Mock };
  let provider: LocalTseProvider;

  const config = { agentDeviceId: 'agent-1', organizationId: 'org-1' };

  beforeEach(() => {
    gatewayService = { sendTseJobToAgent: jest.fn() };
    provider = new LocalTseProvider(gatewayService as unknown as GatewayService);
  });

  describe('recordTransaction', () => {
    const input = { organizationId: 'org-1', clientId: 'client-1', amount: 10, currency: 'EUR', paymentMethod: 'cash' };

    it('dispatches a sign job to the configured agent device and maps the response', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue({
        ok: true,
        transactionNumber: 3,
        serialNumber: 'SN-1',
        signatureCounter: 2,
        signatureValue: 'sig',
        signatureAlgorithm: 'algo',
        startTime: 't0',
        endTime: 't1',
        qrCodeData: 'qr',
      });

      const result = await provider.recordTransaction(config, input);

      expect(gatewayService.sendTseJobToAgent).toHaveBeenCalledWith(
        'org-1',
        'agent-1',
        GatewayEvents.TSE_SIGN_TRANSACTION,
        expect.objectContaining({ clientId: 'client-1', amount: 10, currency: 'EUR', paymentMethod: 'cash' }),
        15000,
      );
      expect(result).toEqual(
        expect.objectContaining({ provider: 'local', clientId: 'client-1', transactionNumber: 3, signatureValue: 'sig' }),
      );
    });

    it('throws when the agent does not respond (offline)', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue(null);

      await expect(provider.recordTransaction(config, input)).rejects.toThrow(/offline|did not respond/);
    });

    it('throws with the agent-reported error when signing fails on the hardware side', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue({ ok: false, error: 'stick not inserted' });

      await expect(provider.recordTransaction(config, input)).rejects.toThrow('stick not inserted');
    });
  });

  describe('testConnection', () => {
    it('reports not ok when the agent is unreachable', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue(null);

      const result = await provider.testConnection(config);

      expect(result.ok).toBe(false);
    });

    it('passes through the agent response', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue({ ok: true, serialNumber: 'SN-1' });

      const result = await provider.testConnection(config);

      expect(result).toEqual({ ok: true, message: 'SN-1' });
    });
  });

  describe('exportData', () => {
    const input = { organizationId: 'org-1', clientId: 'client-1', periodStart: new Date('2026-08-21'), periodEnd: new Date('2026-08-23') };

    it('decodes the base64 payload from the agent into a Buffer', async () => {
      const raw = Buffer.from('archive-bytes');
      gatewayService.sendTseJobToAgent.mockResolvedValue({
        ok: true,
        dataBase64: raw.toString('base64'),
        filename: 'export.tar',
      });

      const result = await provider.exportData(config, input);

      expect(result.data.equals(raw)).toBe(true);
      expect(result.filename).toBe('export.tar');
    });

    it('throws when the agent export fails', async () => {
      gatewayService.sendTseJobToAgent.mockResolvedValue({ ok: false, message: 'stick full' });

      await expect(provider.exportData(config, input)).rejects.toThrow('stick full');
    });
  });
});
