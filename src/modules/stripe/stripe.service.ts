import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  Organization,
  CreditPackage,
  CreditPurchase,
  SubscriptionConfig,
  SubscriptionStatus,
  CreditPaymentMethod,
  CreditPaymentStatus,
} from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  private readonly isConfigured: boolean;

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(CreditPackage)
    private readonly creditPackageRepository: Repository<CreditPackage>,
    @InjectRepository(CreditPurchase)
    private readonly creditPurchaseRepository: Repository<CreditPurchase>,
    @InjectRepository(SubscriptionConfig)
    private readonly subscriptionConfigRepository: Repository<SubscriptionConfig>,
    private readonly configService: ConfigService,
  ) {
    const stripeSecretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!stripeSecretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not configured - Stripe features will be disabled. ' +
        'Set STRIPE_SECRET_KEY in your environment to enable payments.',
      );
      this.stripe = null;
      this.isConfigured = false;
    } else {
      this.stripe = new Stripe(stripeSecretKey);
      this.isConfigured = true;
    }
  }

  /**
   * Check if Stripe is configured and throw if not
   */
  private ensureStripeConfigured(): Stripe {
    if (!this.stripe) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Stripe ist nicht konfiguriert. Bitte kontaktieren Sie den Administrator.',
      });
    }
    return this.stripe;
  }

  /**
   * Get or create Stripe customer for organization
   */
  async getOrCreateCustomer(organization: Organization): Promise<string> {
    const stripe = this.ensureStripeConfigured();

    if (organization.stripeCustomerId) {
      return organization.stripeCustomerId;
    }

    const customer = await stripe.customers.create({
      name: organization.name,
      email: organization.billingEmail || undefined,
      metadata: {
        organizationId: organization.id,
      },
    });

    organization.stripeCustomerId = customer.id;
    await this.organizationRepository.save(organization);

    this.logger.log(`Created Stripe customer ${customer.id} for org ${organization.id}`);

    return customer.id;
  }

  /**
   * Create checkout session for credit package purchase
   */
  async createCreditCheckoutSession(
    organization: Organization,
    packageId: string,
    userId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const stripe = this.ensureStripeConfigured();

    const pkg = await this.creditPackageRepository.findOne({
      where: { id: packageId, isActive: true },
    });

    if (!pkg) {
      throw new NotFoundException({
        code: ErrorCodes.INVALID_PACKAGE,
        message: 'Paket nicht gefunden oder nicht verfügbar',
      });
    }

    const customerId = await this.getOrCreateCustomer(organization);

    // Create pending purchase record
    const purchase = this.creditPurchaseRepository.create({
      organizationId: organization.id,
      packageId: pkg.id,
      credits: pkg.credits,
      amount: pkg.price,
      paymentMethod: CreditPaymentMethod.STRIPE,
      paymentStatus: CreditPaymentStatus.PENDING,
      purchasedByUserId: userId,
    });
    await this.creditPurchaseRepository.save(purchase);

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: pkg.name,
              description: `${pkg.credits} Event-Credits`,
            },
            unit_amount: Math.round(Number(pkg.price) * 100), // in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        purchaseId: purchase.id,
        organizationId: organization.id,
        type: 'credit_purchase',
      },
    });

    // Update purchase with session ID
    purchase.stripeCheckoutSessionId = session.id;
    await this.creditPurchaseRepository.save(purchase);

    this.logger.log(`Created checkout session ${session.id} for org ${organization.id}`);

    return session.url!;
  }

  /**
   * Create checkout session for subscription
   */
  async createSubscriptionCheckoutSession(
    organization: Organization,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const stripe = this.ensureStripeConfigured();

    // Get active subscription config
    const subscriptionConfig = await this.subscriptionConfigRepository.findOne({
      where: { isActive: true },
    });

    if (!subscriptionConfig) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine aktive Abo-Konfiguration verfügbar',
      });
    }

    if (organization.stripeSubscriptionId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Organisation hat bereits ein aktives Abo',
      });
    }

    const customerId = await this.getOrCreateCustomer(organization);

    // Create or get price ID
    let priceId = subscriptionConfig.stripePriceId;
    if (!priceId) {
      // Create product and price in Stripe
      const product = await stripe.products.create({
        name: subscriptionConfig.name,
        description: subscriptionConfig.description || undefined,
        metadata: {
          subscriptionConfigId: subscriptionConfig.id,
        },
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(Number(subscriptionConfig.priceMonthly) * 100),
        currency: 'eur',
        recurring: {
          interval: 'month',
        },
      });

      subscriptionConfig.stripeProductId = product.id;
      subscriptionConfig.stripePriceId = price.id;
      await this.subscriptionConfigRepository.save(subscriptionConfig);

      priceId = price.id;
    }

    // Create checkout session for subscription
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        organizationId: organization.id,
        type: 'subscription',
      },
    });

    this.logger.log(`Created subscription checkout ${session.id} for org ${organization.id}`);

    return session.url!;
  }

  /**
   * Create billing portal session
   */
  async createPortalSession(
    organization: Organization,
    returnUrl: string,
  ): Promise<string> {
    const stripe = this.ensureStripeConfigured();

    if (!organization.stripeCustomerId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Keine Zahlungsinformationen vorhanden',
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: organization.stripeCustomerId,
      return_url: returnUrl,
    });

    return session.url;
  }

  /**
   * Get billing overview for organization
   */
  async getBillingOverview(organization: Organization): Promise<{
    subscription: {
      status: SubscriptionStatus | null;
      currentPeriodEnd: Date | null;
      priceMonthly: number | null;
      creditsPerMonth: number | null;
    };
    credits: number;
    packages: CreditPackage[];
  }> {
    // Get active subscription config
    const subscriptionConfig = await this.subscriptionConfigRepository.findOne({
      where: { isActive: true },
    });

    // Get available credit packages
    const packages = await this.creditPackageRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC' },
    });

    return {
      subscription: {
        status: organization.subscriptionStatus,
        currentPeriodEnd: organization.subscriptionCurrentPeriodEnd,
        priceMonthly: subscriptionConfig ? Number(subscriptionConfig.priceMonthly) : null,
        creditsPerMonth: subscriptionConfig?.creditsPerMonth || null,
      },
      credits: organization.eventCredits,
      packages,
    };
  }

  /**
   * Get payment history for organization
   */
  async getPaymentHistory(
    organizationId: string,
    limit: number = 20,
  ): Promise<CreditPurchase[]> {
    return this.creditPurchaseRepository.find({
      where: { organizationId },
      relations: ['package'],
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Handle checkout session completed webhook
   */
  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const metadata = session.metadata || {};

    if (metadata.type === 'credit_purchase') {
      await this.handleCreditPurchaseCompleted(session);
    } else if (metadata.type === 'subscription') {
      await this.handleSubscriptionCreated(session);
    }
  }

  private async handleCreditPurchaseCompleted(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const purchaseId = session.metadata?.purchaseId;
    if (!purchaseId) return;

    const purchase = await this.creditPurchaseRepository.findOne({
      where: { id: purchaseId },
    });

    if (!purchase || purchase.paymentStatus === CreditPaymentStatus.COMPLETED) {
      return;
    }

    // Update purchase
    purchase.paymentStatus = CreditPaymentStatus.COMPLETED;
    purchase.stripePaymentIntentId = session.payment_intent as string;
    purchase.completedAt = new Date();
    await this.creditPurchaseRepository.save(purchase);

    // Add credits to organization
    await this.organizationRepository.increment(
      { id: purchase.organizationId },
      'eventCredits',
      purchase.credits,
    );

    this.logger.log(
      `Credit purchase completed: ${purchase.credits} credits added to org ${purchase.organizationId}`,
    );
  }

  private async handleSubscriptionCreated(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const stripe = this.ensureStripeConfigured();

    const organizationId = session.metadata?.organizationId;
    if (!organizationId) return;

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) return;

    // Get subscription details
    const subscriptionId = session.subscription as string;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    organization.stripeSubscriptionId = subscriptionId;
    organization.subscriptionStatus = this.mapSubscriptionStatus(subscription.status);
    organization.subscriptionCurrentPeriodEnd = new Date(
      (subscription as unknown as { current_period_end: number }).current_period_end * 1000,
    );
    await this.organizationRepository.save(organization);

    // Grant initial credits
    await this.grantSubscriptionCredits(organization);

    this.logger.log(`Subscription created for org ${organizationId}`);
  }

  /**
   * Handle subscription updated webhook
   */
  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;

    const organization = await this.organizationRepository.findOne({
      where: { stripeCustomerId: customerId },
    });

    if (!organization) return;

    organization.subscriptionStatus = this.mapSubscriptionStatus(subscription.status);
    organization.subscriptionCurrentPeriodEnd = new Date(
      (subscription as unknown as { current_period_end: number }).current_period_end * 1000,
    );
    await this.organizationRepository.save(organization);

    this.logger.log(`Subscription updated for org ${organization.id}: ${subscription.status}`);
  }

  /**
   * Handle subscription deleted webhook
   */
  async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const customerId = subscription.customer as string;

    const organization = await this.organizationRepository.findOne({
      where: { stripeCustomerId: customerId },
    });

    if (!organization) return;

    organization.stripeSubscriptionId = null;
    organization.subscriptionStatus = SubscriptionStatus.CANCELED;
    organization.subscriptionCurrentPeriodEnd = null;
    await this.organizationRepository.save(organization);

    this.logger.log(`Subscription canceled for org ${organization.id}`);
  }

  /**
   * Handle invoice paid webhook (for subscription renewals)
   */
  async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const stripe = this.ensureStripeConfigured();

    const invoiceAny = invoice as unknown as { subscription?: string; customer: string };
    if (!invoiceAny.subscription) return; // Only for subscription invoices

    const customerId = invoiceAny.customer;
    const organization = await this.organizationRepository.findOne({
      where: { stripeCustomerId: customerId },
    });

    if (!organization) return;

    // Check if this is a renewal (not the first invoice)
    const subscription = await stripe.subscriptions.retrieve(
      invoiceAny.subscription,
    );

    // Update period end
    organization.subscriptionCurrentPeriodEnd = new Date(
      (subscription as unknown as { current_period_end: number }).current_period_end * 1000,
    );
    await this.organizationRepository.save(organization);

    // Grant monthly credits
    await this.grantSubscriptionCredits(organization);

    this.logger.log(`Invoice paid for org ${organization.id}, credits granted`);
  }

  /**
   * Grant monthly subscription credits
   */
  private async grantSubscriptionCredits(organization: Organization): Promise<void> {
    const subscriptionConfig = await this.subscriptionConfigRepository.findOne({
      where: { isActive: true },
    });

    if (!subscriptionConfig) return;

    // Check if credits were already granted this period
    const now = new Date();
    const lastGrant = organization.subscriptionCreditsGrantedAt;

    if (lastGrant) {
      // Simple check: don't grant if last grant was within 25 days
      const daysSinceLastGrant =
        (now.getTime() - lastGrant.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLastGrant < 25) {
        this.logger.log(`Credits already granted recently for org ${organization.id}`);
        return;
      }
    }

    // Grant credits
    await this.organizationRepository.increment(
      { id: organization.id },
      'eventCredits',
      subscriptionConfig.creditsPerMonth,
    );

    // Update grant timestamp
    organization.subscriptionCreditsGrantedAt = now;
    await this.organizationRepository.save(organization);

    this.logger.log(
      `Granted ${subscriptionConfig.creditsPerMonth} subscription credits to org ${organization.id}`,
    );
  }

  /**
   * Sync credit package to Stripe
   */
  async syncPackageToStripe(packageId: string): Promise<void> {
    const stripe = this.ensureStripeConfigured();

    const pkg = await this.creditPackageRepository.findOneOrFail({
      where: { id: packageId },
    });

    if (pkg.stripeProductId) {
      // Update existing product
      await stripe.products.update(pkg.stripeProductId, {
        name: pkg.name,
        description: pkg.description || undefined,
        active: pkg.isActive,
      });

      if (pkg.stripePriceId) {
        // Archive old price and create new one if price changed
        const currentPrice = await stripe.prices.retrieve(pkg.stripePriceId);
        const currentAmount = currentPrice.unit_amount || 0;

        if (currentAmount !== Math.round(Number(pkg.price) * 100)) {
          // Archive old price
          await stripe.prices.update(pkg.stripePriceId, { active: false });

          // Create new price
          const newPrice = await stripe.prices.create({
            product: pkg.stripeProductId,
            unit_amount: Math.round(Number(pkg.price) * 100),
            currency: 'eur',
          });

          pkg.stripePriceId = newPrice.id;
          await this.creditPackageRepository.save(pkg);
        }
      }
    } else {
      // Create new product
      const product = await stripe.products.create({
        name: pkg.name,
        description: pkg.description || undefined,
        metadata: {
          packageId: pkg.id,
          credits: pkg.credits.toString(),
        },
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(Number(pkg.price) * 100),
        currency: 'eur',
      });

      pkg.stripeProductId = product.id;
      pkg.stripePriceId = price.id;
      await this.creditPackageRepository.save(pkg);
    }

    this.logger.log(`Synced package ${pkg.id} to Stripe`);
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: Buffer,
    signature: string,
  ): Stripe.Event {
    const stripe = this.ensureStripeConfigured();

    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }

    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  }

  private mapSubscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    const statusMap: Record<Stripe.Subscription.Status, SubscriptionStatus> = {
      active: SubscriptionStatus.ACTIVE,
      past_due: SubscriptionStatus.PAST_DUE,
      canceled: SubscriptionStatus.CANCELED,
      incomplete: SubscriptionStatus.INCOMPLETE,
      incomplete_expired: SubscriptionStatus.CANCELED,
      trialing: SubscriptionStatus.TRIALING,
      unpaid: SubscriptionStatus.PAST_DUE,
      paused: SubscriptionStatus.PAST_DUE,
    };
    return statusMap[status] || SubscriptionStatus.INCOMPLETE;
  }
}
