import {
  OPERATING_MODE_SELECT,
  getOperatingMode,
  isOrdersOnly,
} from '../../common/utils/operating-mode.util';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { EventPhaseService } from './event-phase.service';
import { resolveShopHoursMode, shopAvailability } from './shop-availability';
import { Category } from '../../database/entities/category.entity';
import { Product } from '../../database/entities/product.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { toPublicLegalInfo } from '../organizations/legal/legal-settings.util';

// Oeffnungszeiten: siehe shop-availability.ts (hier weiter exportiert).
export {
  resolveShopHoursMode,
  resolveShopWindows,
  weeklyHoursForDays,
} from './shop-availability';

@ApiTags('Shop (Public)')
@Controller('public/shop')
@Public()
export class EventsShopPublicController {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly deployment: DeploymentService,
    // Optional mit Rueckfall fuer von Hand gebaute Tests (Standardwerte).
    @Optional()
    private readonly eventPhaseService?: EventPhaseService,
  ) {}

  private get eventPhase(): EventPhaseService {
    return (
      this.eventPhaseService ??
      EventPhaseService.standalone(this.organizationRepository)
    );
  }

  private async loadShopEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });
    const shopEnabled = event?.settings?.shop?.enabled === true;
    const isLive =
      event?.status === EventStatus.ACTIVE ||
      event?.status === EventStatus.TEST;
    if (!event || !shopEnabled || !isLive) {
      throw new NotFoundException({
        code: 'SHOP_NOT_FOUND',
        message: 'Shop nicht gefunden oder nicht aktiviert',
      });
    }
    return event;
  }

  @Get(':eventId')
  @ApiOperation({
    summary:
      'Get public shop info for an event (must have settings.shop.enabled)',
  })
  async getShop(@Param('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.loadShopEvent(eventId);
    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const currency =
      (organization?.settings as { currency?: string } | null)?.currency ||
      'EUR';
    const timezone = organization?.settings?.timezone || 'Europe/Berlin';
    const openingHours = event.settings?.shop?.openingHours ?? null;
    const hoursMode = resolveShopHoursMode(
      event.settings?.shop?.hoursMode,
      openingHours,
    );
    const rawFee = event.settings?.shop?.serviceFee;
    const serviceFee =
      typeof rawFee === 'number' && rawFee > 0 ? Number(rawFee.toFixed(2)) : 0;
    const testMode = event.status === EventStatus.TEST;
    const now = new Date();
    // Phase der Veranstaltung und Oeffnungszeiten zusammen: vor dem
    // Verkaufsfenster nur mit Vorverkauf, danach gar nicht mehr.
    const phase = this.eventPhase.resolveWith(event, organization, now);
    const availability = shopAvailability(event, timezone, phase, now);
    const { windows, isOpenNow, nextOpening } = availability;

    return {
      data: {
        event: {
          id: event.id,
          name: event.name,
          description: event.description,
          status: event.status,
          startDate: event.startDate,
          endDate: event.endDate,
          organizationName: organization?.name || '',
          phase: phase.phase,
          realSalesFrom: phase.realSalesFrom,
          realSalesUntil: phase.realSalesUntil,
        },
        currency,
        shop: {
          hoursMode,
          windows,
          nextOpening,
          openingHours,
          serviceFee,
          isOpenNow,
          testMode,
          // test | presale | open | closed | not_started | ended
          state: availability.state,
          presale: {
            enabled: phase.presaleEnabled,
            active: availability.state === 'presale',
            until: phase.presaleEnabled ? phase.realSalesFrom : null,
            windows: availability.presaleWindows,
          },
          // Betriebsart „Nur Bons“: keine Online-Bestellungen (keine
          // Vorkasse, keine Preise) — der Shop zeigt „Bestellungen nur vor
          // Ort“ statt der Karte.
          operatingMode: getOperatingMode(organization),
          onlineOrderingAvailable: !isOrdersOnly(organization),
        },
        // Impressum und Datenschutz des Vereins (er verkauft) plus die
        // Plattform-Links von OpenEOS — nur diese Felder, nichts sonst aus
        // den Organisationseinstellungen.
        legal: toPublicLegalInfo(organization, this.deployment.platformLegal),
      },
    };
  }

  @Get(':eventId/categories')
  @ApiOperation({ summary: 'List active categories for the shop' })
  async getCategories(@Param('eventId', ParseUUIDPipe) eventId: string) {
    await this.loadShopEvent(eventId);
    const categories = await this.categoryRepository.find({
      where: { eventId, isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return {
      data: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        icon: c.icon,
        sortOrder: c.sortOrder,
        parentId: c.parentId,
      })),
    };
  }

  @Get(':eventId/products')
  @ApiOperation({ summary: 'List available products for the shop' })
  async getProducts(@Param('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.loadShopEvent(eventId);
    // „Nur Bons“: keine Online-Bestellung, keine Preise.
    if (
      isOrdersOnly(
        await this.organizationRepository.findOne({
          where: { id: event.organizationId },
          select: OPERATING_MODE_SELECT,
        }),
      )
    ) {
      return { data: [] };
    }
    const products = await this.productRepository.find({
      where: { eventId, isActive: true, isAvailable: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });

    const visible = products.filter(
      (p) => !p.trackInventory || p.stockQuantity > 0,
    );

    return {
      data: visible.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        imageUrl: p.imageUrl,
        categoryId: p.categoryId,
        sortOrder: p.sortOrder,
        options: p.options,
        trackInventory: p.trackInventory,
        stockQuantity: p.trackInventory ? p.stockQuantity : null,
        stockUnit: p.stockUnit,
      })),
    };
  }
}
