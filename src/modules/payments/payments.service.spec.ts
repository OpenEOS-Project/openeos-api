import { PaymentsService } from './payments.service';
import { PaymentMethod, PaymentTransactionStatus } from '../../database/entities/payment.entity';
import { PaymentStatus } from '../../database/entities/order.entity';

describe('PaymentsService — TSE hook in create()', () => {
  let paymentRepository: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let orderRepository: { findOne: jest.Mock; save: jest.Mock };
  let orderItemRepository: { save: jest.Mock };
  let orderItemPaymentRepository: {};
  let userOrganizationRepository: { findOne: jest.Mock };
  let orderPrintService: { handlePaymentReceived: jest.Mock };
  let tseService: { recordTransaction: jest.Mock };
  let service: PaymentsService;

  const ORG_ID = 'org-1';
  const user = { id: 'user-1' } as any;

  const baseOrder = () => ({
    id: 'order-1',
    organizationId: ORG_ID,
    orderNumber: 'A-1',
    total: 100,
    paidAmount: 0,
    paymentStatus: PaymentStatus.UNPAID,
    createdByDeviceId: 'device-1',
    items: [],
  });

  const createDto = { orderId: 'order-1', amount: 20, paymentMethod: PaymentMethod.CASH } as any;

  beforeEach(() => {
    paymentRepository = {
      create: jest.fn((dto) => ({ ...dto, id: 'payment-1' })),
      save: jest.fn(async (p) => p),
      findOne: jest.fn(),
    };
    orderRepository = { findOne: jest.fn(), save: jest.fn(async (o) => o) };
    orderItemRepository = { save: jest.fn() };
    orderItemPaymentRepository = {};
    userOrganizationRepository = { findOne: jest.fn().mockResolvedValue({ id: 'membership-1' }) };
    orderPrintService = { handlePaymentReceived: jest.fn().mockResolvedValue(undefined) };
    tseService = { recordTransaction: jest.fn() };

    service = new PaymentsService(
      paymentRepository as any,
      orderRepository as any,
      orderItemRepository as any,
      orderItemPaymentRepository as any,
      userOrganizationRepository as any,
      orderPrintService as any,
      tseService as any,
    );

    // create() ends by calling this.findOne(...) to return the fresh row —
    // stub the repository call it makes so the happy path resolves.
    paymentRepository.findOne = jest.fn().mockImplementation(async () => ({
      id: 'payment-1',
      order: { organizationId: ORG_ID },
    }));
  });

  it('signs the payment through TSE, persists tseData, and includes it in the print payload', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockResolvedValue({
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
      failed: false,
    });

    await service.create(ORG_ID, createDto, user);

    expect(tseService.recordTransaction).toHaveBeenCalledWith(
      ORG_ID,
      'device-1',
      expect.objectContaining({ amount: 20, paymentMethod: PaymentMethod.CASH }),
    );
    // Saved once on creation, again once the TSE signature is attached.
    expect(paymentRepository.save).toHaveBeenCalledTimes(2);
    const savedWithTse = paymentRepository.save.mock.calls[1][0];
    expect(savedWithTse.tseData).toEqual(expect.objectContaining({ signatureValue: 'sig' }));

    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tseData: expect.objectContaining({ signatureValue: 'sig' }) }),
    );
  });

  it('is a no-op when TSE is not configured for the org', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockResolvedValue(null);

    await service.create(ORG_ID, createDto, user);

    // Only the initial create-time save — no second save for tseData.
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ tseData: undefined }),
    );
  });

  it('never lets a TSE outage block payment creation', async () => {
    orderRepository.findOne.mockResolvedValue(baseOrder());
    tseService.recordTransaction.mockRejectedValue(new Error('TSE server unreachable'));

    const result = await service.create(ORG_ID, createDto, user);

    expect(result).toBeDefined();
    expect(orderPrintService.handlePaymentReceived).toHaveBeenCalled();
    // No second save attempted — recordTransaction rejected before any tseData existed.
    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
  });

  it('signs using the org-wide client (null device) when the order has no creating device', async () => {
    orderRepository.findOne.mockResolvedValue({ ...baseOrder(), createdByDeviceId: null });
    tseService.recordTransaction.mockResolvedValue(null);

    await service.create(ORG_ID, createDto, user);

    expect(tseService.recordTransaction).toHaveBeenCalledWith(ORG_ID, null, expect.anything());
  });
});
