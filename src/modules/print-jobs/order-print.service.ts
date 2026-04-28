import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization } from '../../database/entities/organization.entity';
import { PrintJobsService } from './print-jobs.service';

@Injectable()
export class OrderPrintService {
  private readonly logger = new Logger(OrderPrintService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly printJobsService: PrintJobsService,
  ) {}

  async handleOrderCreated(
    organizationId: string,
    data: {
      order: any;
      orderId: string;
      orderNumber: string;
      tableNumber?: string | null;
      total: number;
      source: string;
    },
  ): Promise<void> {
    try {
      const orderFlow = await this.getOrderFlow(organizationId);
      if (!orderFlow) return;

      // Kitchen ticket on order creation
      const kitchen = orderFlow.kitchenTicketPrinting;
      if (kitchen?.enabled && kitchen.printerId) {
        await this.printJobsService.createFromWorkflow(
          organizationId,
          kitchen.printerId,
          kitchen.templateId || null,
          data.orderId,
          1,
          {
            order: data.order,
            orderNumber: data.orderNumber,
            tableNumber: data.tableNumber,
            total: data.total,
            source: data.source,
          },
        );
      }

      // Order ticket on order creation
      const orderTicket = orderFlow.orderTicketPrinting;
      if (orderTicket?.enabled && orderTicket.printerId) {
        await this.printJobsService.createFromWorkflow(
          organizationId,
          orderTicket.printerId,
          orderTicket.templateId || null,
          data.orderId,
          1,
          {
            order: data.order,
            orderNumber: data.orderNumber,
            tableNumber: data.tableNumber,
            total: data.total,
            source: data.source,
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle order created printing for org ${organizationId}: ${error.message}`,
      );
    }
  }

  async handlePaymentReceived(
    organizationId: string,
    data: {
      orderId: string;
      orderNumber: string;
      paymentId: string;
      amount: number;
      paymentMethod: string;
      isFullyPaid: boolean;
      order: any;
    },
  ): Promise<void> {
    try {
      const orderFlow = await this.getOrderFlow(organizationId);
      if (!orderFlow) return;

      // Receipt printing on payment
      const receipt = orderFlow.receiptPrinting;
      if (
        receipt?.enabled &&
        receipt.printerId &&
        receipt.trigger === 'payment_received'
      ) {
        await this.printJobsService.createFromWorkflow(
          organizationId,
          receipt.printerId,
          receipt.templateId || null,
          data.orderId,
          1,
          {
            order: data.order,
            orderNumber: data.orderNumber,
            paymentId: data.paymentId,
            amount: data.amount,
            paymentMethod: data.paymentMethod,
            isFullyPaid: data.isFullyPaid,
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle payment received printing for org ${organizationId}: ${error.message}`,
      );
    }
  }

  private async getOrderFlow(
    organizationId: string,
  ): Promise<
    NonNullable<
      import('../../database/entities/organization.entity').OrganizationSettings['orderFlow']
    > | null
  > {
    const org = await this.organizationRepository.findOne({
      where: { id: organizationId },
      select: ['id', 'settings'],
    });
    return org?.settings?.orderFlow || null;
  }
}
