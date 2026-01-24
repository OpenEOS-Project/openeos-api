import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import {
  Order,
  OrderItem,
  Payment,
  Product,
  Category,
  StockMovement,
} from '../../database/entities';
import { OrderStatus } from '../../database/entities/order.entity';
import { QueryReportsDto, ReportGroupBy, ReportExportFormat } from './dto';

export interface SalesReport {
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  totalItemsSold: number;
}

export interface ProductReport {
  productId: string;
  productName: string;
  categoryName: string;
  quantitySold: number;
  revenue: number;
  averagePrice: number;
}

export interface PaymentReport {
  method: string;
  count: number;
  total: number;
  percentage: number;
}

export interface HourlyReport {
  hour: number;
  orders: number;
  revenue: number;
}

export interface StockMovementReport {
  productId: string;
  productName: string;
  openingStock: number;
  additions: number;
  deductions: number;
  closingStock: number;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepository: Repository<StockMovement>,
  ) {}

  async getSalesReport(
    organizationId: string,
    queryDto: QueryReportsDto,
  ): Promise<SalesReport> {
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    } else if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', {
        startDate: new Date(startDate),
      });
    } else if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', {
        endDate: new Date(endDate),
      });
    }

    const result = await queryBuilder
      .select([
        'SUM(order.total) as totalRevenue',
        'COUNT(order.id) as totalOrders',
        'AVG(order.total) as averageOrderValue',
      ])
      .getRawOne();

    // Get total items sold
    const itemsQueryBuilder = this.orderItemRepository
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      itemsQueryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      itemsQueryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const itemsResult = await itemsQueryBuilder
      .select('SUM(item.quantity)', 'totalItems')
      .getRawOne();

    return {
      totalRevenue: Number(result?.totalRevenue || 0),
      totalOrders: Number(result?.totalOrders || 0),
      averageOrderValue: Number(result?.averageOrderValue || 0),
      totalItemsSold: Number(itemsResult?.totalItems || 0),
    };
  }

  async getProductsReport(
    organizationId: string,
    queryDto: QueryReportsDto,
  ): Promise<ProductReport[]> {
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderItemRepository
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'item.productId as productId',
        'item.productName as productName',
        'item.categoryName as categoryName',
        'SUM(item.quantity) as quantitySold',
        'SUM(item.totalPrice) as revenue',
        'AVG(item.unitPrice) as averagePrice',
      ])
      .groupBy('item.productId')
      .addGroupBy('item.productName')
      .addGroupBy('item.categoryName')
      .orderBy('SUM(item.totalPrice)', 'DESC')
      .getRawMany();

    return results.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      categoryName: r.categoryName,
      quantitySold: Number(r.quantitySold || 0),
      revenue: Number(r.revenue || 0),
      averagePrice: Number(r.averagePrice || 0),
    }));
  }

  async getPaymentsReport(
    organizationId: string,
    queryDto: QueryReportsDto,
  ): Promise<PaymentReport[]> {
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.paymentRepository
      .createQueryBuilder('payment')
      .innerJoin('payment.order', 'order')
      .where('order.organizationId = :organizationId', { organizationId });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('payment.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'payment.method as method',
        'COUNT(payment.id) as count',
        'SUM(payment.amount) as total',
      ])
      .groupBy('payment.method')
      .getRawMany();

    const grandTotal = results.reduce((sum, r) => sum + Number(r.total || 0), 0);

    return results.map((r) => ({
      method: r.method,
      count: Number(r.count || 0),
      total: Number(r.total || 0),
      percentage: grandTotal > 0 ? (Number(r.total || 0) / grandTotal) * 100 : 0,
    }));
  }

  async getHourlyReport(
    organizationId: string,
    queryDto: QueryReportsDto,
  ): Promise<HourlyReport[]> {
    const { eventId, startDate, endDate } = queryDto;

    const queryBuilder = this.orderRepository
      .createQueryBuilder('order')
      .where('order.organizationId = :organizationId', { organizationId })
      .andWhere('order.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [OrderStatus.CANCELLED],
      });

    if (eventId) {
      queryBuilder.andWhere('order.eventId = :eventId', { eventId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('order.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'EXTRACT(HOUR FROM order.createdAt) as hour',
        'COUNT(order.id) as orders',
        'SUM(order.total) as revenue',
      ])
      .groupBy('EXTRACT(HOUR FROM order.createdAt)')
      .orderBy('hour', 'ASC')
      .getRawMany();

    // Fill in missing hours
    const hourlyData: HourlyReport[] = [];
    for (let h = 0; h < 24; h++) {
      const found = results.find((r) => Number(r.hour) === h);
      hourlyData.push({
        hour: h,
        orders: Number(found?.orders || 0),
        revenue: Number(found?.revenue || 0),
      });
    }

    return hourlyData;
  }

  async getInventoryReport(
    eventId: string,
  ): Promise<{ productId: string; productName: string; currentStock: number; lowStock: boolean }[]> {
    const products = await this.productRepository.find({
      where: { eventId, trackInventory: true },
      order: { name: 'ASC' },
    });

    return products.map((p) => ({
      productId: p.id,
      productName: p.name,
      currentStock: p.stockQuantity,
      lowStock: p.stockQuantity <= 0,
    }));
  }

  async getStockMovementsReport(
    eventId: string,
    queryDto: QueryReportsDto,
  ): Promise<StockMovementReport[]> {
    const { startDate, endDate } = queryDto;

    const queryBuilder = this.stockMovementRepository
      .createQueryBuilder('movement')
      .leftJoin('movement.product', 'product')
      .where('movement.eventId = :eventId', { eventId });

    if (startDate && endDate) {
      queryBuilder.andWhere('movement.createdAt BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const results = await queryBuilder
      .select([
        'movement.productId as productId',
        'product.name as productName',
        'SUM(CASE WHEN movement.quantity > 0 THEN movement.quantity ELSE 0 END) as additions',
        'SUM(CASE WHEN movement.quantity < 0 THEN ABS(movement.quantity) ELSE 0 END) as deductions',
      ])
      .groupBy('movement.productId')
      .addGroupBy('product.name')
      .getRawMany();

    // Get current stock for each product
    const productIds = results.map((r) => r.productId);
    const products = await this.productRepository.findByIds(productIds);
    const productMap = new Map(products.map((p) => [p.id, p]));

    return results.map((r) => {
      const product = productMap.get(r.productId);
      const additions = Number(r.additions || 0);
      const deductions = Number(r.deductions || 0);
      const closingStock = product?.stockQuantity || 0;
      const openingStock = closingStock + deductions - additions;

      return {
        productId: r.productId,
        productName: r.productName,
        openingStock,
        additions,
        deductions,
        closingStock,
      };
    });
  }

  async exportReport(
    organizationId: string,
    reportType: string,
    queryDto: QueryReportsDto,
    format: ReportExportFormat,
  ): Promise<{ data: string; contentType: string; filename: string }> {
    let reportData: unknown[];
    let filename = `report-${reportType}-${new Date().toISOString().slice(0, 10)}`;

    switch (reportType) {
      case 'sales':
        reportData = [await this.getSalesReport(organizationId, queryDto)];
        break;
      case 'products':
        reportData = await this.getProductsReport(organizationId, queryDto);
        break;
      case 'payments':
        reportData = await this.getPaymentsReport(organizationId, queryDto);
        break;
      case 'hourly':
        reportData = await this.getHourlyReport(organizationId, queryDto);
        break;
      case 'inventory':
        if (queryDto.eventId) {
          reportData = await this.getInventoryReport(queryDto.eventId);
        } else {
          reportData = [];
        }
        break;
      default:
        reportData = [];
    }

    if (format === ReportExportFormat.JSON) {
      return {
        data: JSON.stringify(reportData, null, 2),
        contentType: 'application/json',
        filename: `${filename}.json`,
      };
    }

    if (format === ReportExportFormat.CSV) {
      const csvData = this.convertToCSV(reportData);
      return {
        data: csvData,
        contentType: 'text/csv',
        filename: `${filename}.csv`,
      };
    }

    // For Excel, return JSON (actual Excel generation would need a library like exceljs)
    return {
      data: JSON.stringify(reportData, null, 2),
      contentType: 'application/json',
      filename: `${filename}.json`,
    };
  }

  private convertToCSV(data: unknown[]): string {
    if (data.length === 0) return '';

    const headers = Object.keys(data[0] as Record<string, unknown>);
    const rows = data.map((row) =>
      headers.map((h) => {
        const val = (row as Record<string, unknown>)[h];
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val}"`;
        }
        return String(val ?? '');
      }).join(',')
    );

    return [headers.join(','), ...rows].join('\n');
  }
}
