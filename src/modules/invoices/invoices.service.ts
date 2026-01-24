import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, Organization } from '../../database/entities';
import { InvoiceStatus } from '../../database/entities/invoice.entity';
import { ErrorCodes } from '../../common/constants/error-codes';
import { QueryInvoicesDto } from './dto';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    @InjectRepository(Invoice)
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
  ) {}

  async findAll(
    organizationId: string,
    queryDto: QueryInvoicesDto,
  ): Promise<{ data: Invoice[]; total: number; page: number; limit: number }> {
    const { status, startDate, endDate, page = 1, limit = 20 } = queryDto;

    const queryBuilder = this.invoiceRepository
      .createQueryBuilder('invoice')
      .where('invoice.organizationId = :organizationId', { organizationId });

    if (status) {
      queryBuilder.andWhere('invoice.status = :status', { status });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('invoice.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('invoice.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('invoice.createdAt <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    const total = await queryBuilder.getCount();

    const data = await queryBuilder
      .orderBy('invoice.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { data, total, page, limit };
  }

  async findOne(organizationId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId, organizationId },
    });

    if (!invoice) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Rechnung nicht gefunden',
      });
    }

    return invoice;
  }

  async findByNumber(invoiceNumber: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { invoiceNumber },
      relations: ['organization'],
    });

    if (!invoice) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Rechnung nicht gefunden',
      });
    }

    return invoice;
  }

  async generatePdfUrl(organizationId: string, invoiceId: string): Promise<string> {
    const invoice = await this.findOne(organizationId, invoiceId);

    // In production, this would generate a signed URL for the PDF
    // For now, we return a mock URL
    const pdfUrl = `/api/invoices/${invoice.id}/pdf`;

    if (!invoice.pdfUrl) {
      invoice.pdfUrl = pdfUrl;
      await this.invoiceRepository.save(invoice);
    }

    return invoice.pdfUrl;
  }

  // Admin methods (used by Admin module)
  async markAsPaid(invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Rechnung nicht gefunden',
      });
    }

    invoice.status = InvoiceStatus.PAID;
    invoice.paidAt = new Date();
    await this.invoiceRepository.save(invoice);

    this.logger.log(`Invoice ${invoice.invoiceNumber} marked as paid`);

    return invoice;
  }

  async createInvoice(
    organizationId: string,
    data: {
      lineItems: {
        description: string;
        quantity: number;
        unitPrice: number;
        packageId?: string;
        credits?: number;
      }[];
      billingAddress?: {
        company?: string;
        name?: string;
        street: string;
        city: string;
        zip: string;
        country: string;
      };
      taxRate?: number;
    },
  ): Promise<Invoice> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    const invoiceNumber = await this.generateInvoiceNumber();
    const taxRate = data.taxRate ?? 19.0;

    const lineItems = data.lineItems.map((item) => ({
      ...item,
      total: item.quantity * item.unitPrice,
    }));

    const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const taxAmount = subtotal * (taxRate / 100);
    const total = subtotal + taxAmount;

    const invoice = this.invoiceRepository.create({
      organizationId,
      invoiceNumber,
      status: InvoiceStatus.PENDING,
      subtotal,
      taxRate,
      taxAmount,
      total,
      lineItems,
      billingAddress: data.billingAddress || null,
    });

    await this.invoiceRepository.save(invoice);

    this.logger.log(`Invoice created: ${invoiceNumber} for org ${organizationId}`);

    return invoice;
  }

  private async generateInvoiceNumber(): Promise<string> {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const count = await this.invoiceRepository
      .createQueryBuilder('invoice')
      .where('invoice.invoiceNumber LIKE :prefix', { prefix: `INV-${year}${month}%` })
      .getCount();

    return `INV-${year}${month}-${String(count + 1).padStart(4, '0')}`;
  }
}
