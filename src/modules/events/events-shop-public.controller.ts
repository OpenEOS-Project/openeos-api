import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import {
  Event,
  EventStatus,
  ShopOpeningHours,
  ShopTimeWindow,
  ShopWeekday,
} from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Category } from '../../database/entities/category.entity';
import { Product } from '../../database/entities/product.entity';

const WEEKDAY_KEYS: ShopWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function isWithinEventDateRange(
  now: Date,
  startDate: Date | string | null,
  endDate: Date | string | null,
): boolean {
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (start) {
    const startDay = new Date(start);
    startDay.setHours(0, 0, 0, 0);
    if (now < startDay) return false;
  }
  if (end) {
    const endDay = new Date(end);
    endDay.setHours(23, 59, 59, 999);
    if (now > endDay) return false;
  }
  return true;
}

export function isShopOpenAt(now: Date, hours: ShopOpeningHours | null | undefined): boolean {
  if (!hours) return true;
  const todayWindow: ShopTimeWindow | null | undefined = hours[WEEKDAY_KEYS[now.getDay()]];
  // No setting for today → treat as always open (matches PRD default)
  if (todayWindow === undefined) {
    const allUndefined = WEEKDAY_KEYS.every((k) => hours[k] === undefined);
    return allUndefined;
  }
  if (todayWindow === null) return false;
  const start = parseHHMM(todayWindow.start);
  const end = parseHHMM(todayWindow.end);
  if (start === null || end === null) return true;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  if (end <= start) return false;
  return minutesNow >= start && minutesNow < end;
}

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
  ) {}

  private async loadShopEvent(eventId: string): Promise<Event> {
    const event = await this.eventRepository.findOne({ where: { id: eventId } });
    const shopEnabled = event?.settings?.shop?.enabled === true;
    const isLive =
      event?.status === EventStatus.ACTIVE || event?.status === EventStatus.TEST;
    if (!event || !shopEnabled || !isLive) {
      throw new NotFoundException({
        code: 'SHOP_NOT_FOUND',
        message: 'Shop nicht gefunden oder nicht aktiviert',
      });
    }
    return event;
  }

  @Get(':eventId')
  @ApiOperation({ summary: 'Get public shop info for an event (must have settings.shop.enabled)' })
  async getShop(@Param('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.loadShopEvent(eventId);
    const organization = await this.organizationRepository.findOne({
      where: { id: event.organizationId },
    });
    const currency =
      (organization?.settings as { currency?: string } | null)?.currency || 'EUR';
    const openingHours = event.settings?.shop?.openingHours ?? null;
    const rawFee = event.settings?.shop?.serviceFee;
    const serviceFee = typeof rawFee === 'number' && rawFee > 0 ? Number(rawFee.toFixed(2)) : 0;
    const testMode = event.status === EventStatus.TEST;
    const now = new Date();
    const withinDateRange = isWithinEventDateRange(now, event.startDate, event.endDate);
    const isOpenNow = testMode
      ? true
      : withinDateRange && isShopOpenAt(now, openingHours);

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
        },
        currency,
        shop: {
          openingHours,
          serviceFee,
          isOpenNow,
          testMode,
        },
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
    await this.loadShopEvent(eventId);
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
