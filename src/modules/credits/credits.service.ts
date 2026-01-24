import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import {
  Organization,
  CreditPackage,
  CreditPurchase,
  EventLicense,
} from '../../database/entities';
import {
  CreditPaymentStatus,
  CreditPaymentMethod,
} from '../../database/entities/credit-purchase.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { PurchaseCreditsDto, QueryCreditHistoryDto, QueryEventLicensesDto } from './dto';

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(CreditPackage)
    private readonly creditPackageRepository: Repository<CreditPackage>,
    @InjectRepository(CreditPurchase)
    private readonly creditPurchaseRepository: Repository<CreditPurchase>,
    @InjectRepository(EventLicense)
    private readonly eventLicenseRepository: Repository<EventLicense>,
  ) {}

  async getBalance(organizationId: string): Promise<{
    credits: number;
    pendingCredits: number;
  }> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    // Get pending credits (purchases that are pending)
    const pendingPurchases = await this.creditPurchaseRepository
      .createQueryBuilder('purchase')
      .select('SUM(purchase.credits)', 'total')
      .where('purchase.organizationId = :organizationId', { organizationId })
      .andWhere('purchase.paymentStatus = :status', { status: CreditPaymentStatus.PENDING })
      .getRawOne();

    return {
      credits: organization.eventCredits,
      pendingCredits: Number(pendingPurchases?.total || 0),
    };
  }

  async getPackages(): Promise<CreditPackage[]> {
    return this.creditPackageRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', credits: 'ASC' },
    });
  }

  async getPackageBySlug(slug: string): Promise<CreditPackage> {
    const pkg = await this.creditPackageRepository.findOne({
      where: { slug, isActive: true },
    });

    if (!pkg) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Paket nicht gefunden',
      });
    }

    return pkg;
  }

  async purchaseCredits(
    organizationId: string,
    userId: string,
    purchaseDto: PurchaseCreditsDto,
  ): Promise<CreditPurchase> {
    const pkg = await this.creditPackageRepository.findOne({
      where: { id: purchaseDto.packageId, isActive: true },
    });

    if (!pkg) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Paket nicht gefunden oder nicht mehr verfügbar',
      });
    }

    const purchase = this.creditPurchaseRepository.create({
      organizationId,
      packageId: pkg.id,
      credits: pkg.credits,
      amount: pkg.price,
      paymentMethod: purchaseDto.paymentMethod,
      paymentStatus: CreditPaymentStatus.PENDING,
      purchasedByUserId: userId,
    });

    await this.creditPurchaseRepository.save(purchase);

    this.logger.log(
      `Credit purchase initiated: ${purchase.id} for org ${organizationId}, ${pkg.credits} credits`,
    );

    // For bank transfer and invoice, the purchase stays pending
    // For SumUp, we would return payment info here (mocked for now)
    if (purchaseDto.paymentMethod === CreditPaymentMethod.SUMUP_ONLINE) {
      // In production, this would integrate with SumUp API
      // For now, we just return the pending purchase
    }

    return this.creditPurchaseRepository.findOne({
      where: { id: purchase.id },
      relations: ['package'],
    }) as Promise<CreditPurchase>;
  }

  async completePurchase(
    purchaseId: string,
    transactionId?: string,
  ): Promise<CreditPurchase> {
    const purchase = await this.creditPurchaseRepository.findOne({
      where: { id: purchaseId },
      relations: ['organization'],
    });

    if (!purchase) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Kauf nicht gefunden',
      });
    }

    if (purchase.paymentStatus !== CreditPaymentStatus.PENDING) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Kauf wurde bereits abgeschlossen oder abgebrochen',
      });
    }

    // Update purchase status
    purchase.paymentStatus = CreditPaymentStatus.COMPLETED;
    purchase.completedAt = new Date();
    if (transactionId) {
      purchase.transactionId = transactionId;
    }
    await this.creditPurchaseRepository.save(purchase);

    // Add credits to organization
    await this.organizationRepository.increment(
      { id: purchase.organizationId },
      'eventCredits',
      purchase.credits,
    );

    this.logger.log(
      `Credit purchase completed: ${purchaseId}, ${purchase.credits} credits added to org ${purchase.organizationId}`,
    );

    return purchase;
  }

  async getHistory(
    organizationId: string,
    queryDto: QueryCreditHistoryDto,
  ): Promise<{ data: CreditPurchase[]; total: number; page: number; limit: number }> {
    const { status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.creditPurchaseRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.package', 'package')
      .leftJoinAndSelect('purchase.purchasedByUser', 'user')
      .where('purchase.organizationId = :organizationId', { organizationId });

    if (status) {
      queryBuilder.andWhere('purchase.paymentStatus = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('purchase.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('purchase.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('purchase.createdAt <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('purchase.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async getLicenseUsage(
    organizationId: string,
    queryDto: QueryEventLicensesDto,
  ): Promise<{ data: EventLicense[]; total: number; page: number; limit: number }> {
    const { startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.eventLicenseRepository
      .createQueryBuilder('license')
      .leftJoinAndSelect('license.event', 'event')
      .leftJoinAndSelect('license.activatedByUser', 'user')
      .where('license.organizationId = :organizationId', { organizationId });

    if (startDate && endDate) {
      queryBuilder.andWhere('license.licenseDate BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('license.licenseDate >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('license.licenseDate <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('license.licenseDate', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async useCredit(
    organizationId: string,
    eventId: string,
    userId: string,
    licenseDate: Date,
    creditsNeeded: number = 1,
  ): Promise<EventLicense> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    if (organization.eventCredits < creditsNeeded) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nicht genügend Credits verfügbar',
      });
    }

    // Check if license already exists for this date
    const existingLicense = await this.eventLicenseRepository.findOne({
      where: {
        eventId,
        licenseDate,
      },
    });

    if (existingLicense) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Für dieses Datum wurde bereits eine Lizenz aktiviert',
      });
    }

    // Deduct credits
    await this.organizationRepository.decrement(
      { id: organizationId },
      'eventCredits',
      creditsNeeded,
    );

    // Create license record
    const license = this.eventLicenseRepository.create({
      organizationId,
      eventId,
      licenseDate,
      creditsUsed: creditsNeeded,
      activatedAt: new Date(),
      activatedByUserId: userId,
    });

    await this.eventLicenseRepository.save(license);

    this.logger.log(
      `Event license activated: event ${eventId}, date ${licenseDate.toISOString()}, ${creditsNeeded} credits used`,
    );

    return license;
  }

  async checkLicense(eventId: string, date: Date): Promise<boolean> {
    const license = await this.eventLicenseRepository.findOne({
      where: {
        eventId,
        licenseDate: date,
      },
    });

    return !!license;
  }
}
