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
  ShopWeekday,
} from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import {
  ShopWindow,
  deriveShopWindows,
  isWithinShopWindows,
} from '../../common/utils/event-schedule.util';
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

/**
 * Woraus sich die Oeffnungszeiten dieses Shops ergeben.
 *
 * Neue Shops leiten sie aus dem Veranstaltungszeitraum ab. Shops, die noch
 * eine ausgefuellte Wochentags-Tabelle mitbringen, bleiben darauf, bis sie
 * bewusst umgestellt werden — sonst wuerde ein Bestandsshop von heute auf
 * morgen zu anderen Zeiten oeffnen.
 */
export function resolveShopHoursMode(
  hoursMode: 'event' | 'weekly' | undefined,
  hours: ShopOpeningHours | null | undefined,
): 'event' | 'weekly' {
  if (hoursMode) return hoursMode;
  const hasWeeklyTable = hours ? WEEKDAY_KEYS.some((k) => hours[k] !== undefined) : false;
  return hasWeeklyTable ? 'weekly' : 'event';
}

/** Die konkreten Zeitfenster dieses Shops, unabhaengig vom gewaehlten Modus. */
export function resolveShopWindows(event: Event, timeZone: string): ShopWindow[] {
  const shop = event.settings?.shop;
  const hours = shop?.openingHours ?? null;
  if (resolveShopHoursMode(shop?.hoursMode, hours) === 'event') {
    return deriveShopWindows(event.startDate, event.endDate, timeZone);
  }
  return weeklyHoursToWindows(event, hours, timeZone);
}

/**
 * Die Wochentags-Tabelle in dieselben Fenster uebersetzen, die der
 * abgeleitete Modus liefert — so kennt der Shop nur noch eine Darstellung.
 * Erzeugt werden die Fenster fuer den Veranstaltungszeitraum, hoechstens
 * aber fuer 31 Tage.
 */
function weeklyHoursToWindows(
  event: Event,
  hours: ShopOpeningHours | null,
  timeZone: string,
): ShopWindow[] {
  if (!hours || !event.startDate) return [];
  const windows: ShopWindow[] = [];
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : start;
  const dayCount = Math.min(
    31,
    Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1),
  );

  for (let offset = 0; offset < dayCount; offset += 1) {
    const day = new Date(start.getTime() + offset * 86400000);
    const window = hours[WEEKDAY_KEYS[day.getDay()]];
    if (!window) continue;
    const from = parseHHMM(window.start);
    const until = parseHHMM(window.end);
    if (from === null || until === null || until <= from) continue;
    const midnight = new Date(day);
    midnight.setHours(0, 0, 0, 0);
    windows.push({
      start: new Date(midnight.getTime() + from * 60000).toISOString(),
      end: new Date(midnight.getTime() + until * 60000).toISOString(),
    });
  }
  return windows;
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
    const timezone = organization?.settings?.timezone || 'Europe/Berlin';
    const openingHours = event.settings?.shop?.openingHours ?? null;
    const hoursMode = resolveShopHoursMode(event.settings?.shop?.hoursMode, openingHours);
    const windows = resolveShopWindows(event, timezone);
    const rawFee = event.settings?.shop?.serviceFee;
    const serviceFee = typeof rawFee === 'number' && rawFee > 0 ? Number(rawFee.toFixed(2)) : 0;
    const testMode = event.status === EventStatus.TEST;
    const now = new Date();
    // Die Fenster tragen den Zeitraum bereits in sich — eine zusaetzliche
    // Pruefung gegen Start- und Enddatum waere dieselbe Aussage doppelt.
    const isOpenNow = testMode ? true : isWithinShopWindows(now, windows);
    const nextOpening = windows.map((w) => w.start).find((iso) => new Date(iso) > now) ?? null;

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
          hoursMode,
          windows,
          nextOpening,
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
