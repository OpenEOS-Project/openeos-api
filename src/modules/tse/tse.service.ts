import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from '../../database/entities/organization.entity';
import { Device } from '../../database/entities/device.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { TseTransactionData } from '../../database/entities/payment.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { FiskalyTseProvider } from './providers/fiskaly-tse.provider';
import { NullTseProvider } from './providers/null-tse.provider';
import { TseProvider } from './tse.interface';

@Injectable()
export class TseService {
  private readonly logger = new Logger(TseService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly fiskalyProvider: FiskalyTseProvider,
    private readonly nullProvider: NullTseProvider,
  ) {}

  private getProvider(providerName: 'fiskaly' | 'none' | undefined): TseProvider {
    return providerName === 'fiskaly' ? this.fiskalyProvider : this.nullProvider;
  }

  /**
   * Sign one captured payment through the organization's TSE, if configured.
   * Returns null when TSE is disabled/unconfigured (nothing to store). Never
   * throws — a TSE outage must not block the sale (BMF's Ausfall-Regelung);
   * failures come back as `tseData.failed: true` so the receipt/report can
   * show the gap.
   */
  async recordTransaction(
    organizationId: string,
    deviceId: string | null,
    input: { amount: number; paymentMethod: string },
  ): Promise<TseTransactionData | null> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const tseConfig = organization?.settings?.tse;
    if (!tseConfig?.enabled || tseConfig.provider === 'none' || !tseConfig.fiskaly) {
      return null;
    }

    const clientId = await this.resolveClientId(organizationId, deviceId);
    const provider = this.getProvider(tseConfig.provider);

    try {
      await provider.ensureClient(tseConfig.fiskaly, clientId);
      const result = await provider.recordTransaction(tseConfig.fiskaly, {
        clientId,
        amount: input.amount,
        currency: organization?.settings?.currency ?? 'EUR',
        paymentMethod: input.paymentMethod,
      });
      return { ...result, failed: false };
    } catch (error) {
      this.logger.error(
        `TSE transaction failed for org ${organizationId} (client ${clientId}): ${(error as Error).message}`,
      );
      const now = new Date().toISOString();
      return {
        provider: tseConfig.provider,
        clientId,
        transactionNumber: 0,
        serialNumber: '',
        signatureCounter: 0,
        signatureValue: '',
        signatureAlgorithm: '',
        startTime: now,
        endTime: now,
        processType: 'Kassenbeleg-V1',
        processData: '',
        qrCodeData: '',
        failed: true,
        failureReason: (error as Error).message,
      };
    }
  }

  async testConnection(organizationId: string, userId: string): Promise<{ ok: boolean; message?: string }> {
    await this.checkMembership(organizationId, userId);

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    const tseConfig = organization?.settings?.tse;
    if (!tseConfig?.fiskaly) {
      return { ok: false, message: 'TSE ist für diese Organisation nicht konfiguriert' };
    }
    return this.getProvider(tseConfig.provider).testConnection(tseConfig.fiskaly);
  }

  /**
   * Each till is its own TSE client. Online-shop orders have no device, so
   * they share a single per-organization client instead. fiskaly client IDs
   * must be UUIDs, so both branches reuse an existing UUID rather than
   * building a prefixed string.
   */
  private async resolveClientId(organizationId: string, deviceId: string | null): Promise<string> {
    if (!deviceId) {
      return organizationId;
    }

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
      select: ['id', 'settings'],
    });
    if (device?.settings?.tseClientId) {
      return device.settings.tseClientId;
    }

    const clientId = deviceId;
    if (device) {
      device.settings = { ...device.settings, tseClientId: clientId };
      await this.deviceRepository.save(device);
    }
    return clientId;
  }

  private async checkMembership(organizationId: string, userId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
  }
}
