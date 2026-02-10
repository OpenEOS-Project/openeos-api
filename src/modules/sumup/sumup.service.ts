import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type SumUp from '@sumup/sdk';
import { Organization, User, UserOrganization } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { SumUpApiService } from './sumup-api.service';
import type { SumUpCredentials } from './interfaces/sumup.interfaces';

@Injectable()
export class SumUpService {
  private readonly logger = new Logger(SumUpService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly sumUpApiService: SumUpApiService,
    private readonly configService: ConfigService,
  ) {}

  private async getCredentials(organizationId: string): Promise<SumUpCredentials> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new BadRequestException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    const apiKey = organization.settings?.sumup?.apiKey
      || this.configService.get<string>('SUMUP_API_KEY');
    const merchantCode = organization.settings?.sumup?.merchantCode
      || this.configService.get<string>('SUMUP_MERCHANT_CODE');

    if (!apiKey || !merchantCode) {
      throw new BadRequestException({
        code: ErrorCodes.SUMUP_NOT_CONFIGURED,
        message: 'SumUp ist nicht konfiguriert',
      });
    }

    const affiliateKey = organization.settings?.sumup?.affiliateKey
      || this.configService.get<string>('SUMUP_AFFILIATE_KEY');
    const appId = organization.settings?.sumup?.appId
      || this.configService.get<string>('SUMUP_APP_ID');

    return { apiKey, merchantCode, affiliateKey, appId };
  }

  async testConnection(organizationId: string, user: User): Promise<{ success: boolean }> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    await this.sumUpApiService.listReaders(credentials.apiKey, credentials.merchantCode);

    return { success: true };
  }

  async listReaders(organizationId: string, user: User): Promise<SumUp.Readers.Reader[]> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    return this.sumUpApiService.listReaders(credentials.apiKey, credentials.merchantCode);
  }

  async pairReader(organizationId: string, pairingCode: string, name: string | undefined, user: User): Promise<SumUp.Readers.Reader> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    this.logger.log(`Pairing SumUp reader for organization ${organizationId}`);

    return this.sumUpApiService.pairReader(
      credentials.apiKey,
      credentials.merchantCode,
      pairingCode,
      name || 'Reader',
    );
  }

  async getReaderStatus(organizationId: string, readerId: string, user: User): Promise<SumUp.Readers.StatusResponse> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    return this.sumUpApiService.getReaderStatus(credentials.apiKey, credentials.merchantCode, readerId);
  }

  async updateReader(organizationId: string, readerId: string, name: string, user: User): Promise<SumUp.Readers.Reader> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    this.logger.log(`Updating SumUp reader ${readerId} for organization ${organizationId}`);

    return this.sumUpApiService.updateReader(credentials.apiKey, credentials.merchantCode, readerId, name);
  }

  async deleteReader(organizationId: string, readerId: string, user: User): Promise<void> {
    await this.checkPermission(organizationId, user.id, 'devices');
    const credentials = await this.getCredentials(organizationId);

    this.logger.log(`Deleting SumUp reader ${readerId} for organization ${organizationId}`);

    await this.sumUpApiService.deleteReader(credentials.apiKey, credentials.merchantCode, readerId);
  }

  async initiateCheckout(
    organizationId: string,
    readerId: string,
    amount: number,
    currency: string,
    user: User,
  ): Promise<SumUp.Readers.CreateReaderCheckoutResponse> {
    await this.checkMembership(organizationId, user.id);
    const credentials = await this.getCredentials(organizationId);

    this.logger.log(`Initiating SumUp checkout on reader ${readerId} for ${amount} ${currency}`);

    return this.sumUpApiService.initiateCheckout(
      credentials.apiKey,
      credentials.merchantCode,
      readerId,
      {
        amount,
        currency,
        affiliateKey: credentials.affiliateKey,
        appId: credentials.appId,
      },
    );
  }

  async terminateCheckout(organizationId: string, readerId: string, user: User): Promise<void> {
    await this.checkMembership(organizationId, user.id);
    const credentials = await this.getCredentials(organizationId);

    this.logger.log(`Terminating SumUp checkout on reader ${readerId}`);

    await this.sumUpApiService.terminateCheckout(credentials.apiKey, credentials.merchantCode, readerId);
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

  private async checkPermission(
    organizationId: string,
    userId: string,
    permission: 'products' | 'events' | 'devices' | 'members' | 'shiftPlans',
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    if (membership.role === OrganizationRole.ADMIN) {
      return;
    }

    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
