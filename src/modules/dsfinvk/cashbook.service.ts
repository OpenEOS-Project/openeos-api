import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  assertCashAllowed,
  isCashAllowed,
} from '../../common/utils/operating-mode.util';
import {
  CASHBOOK_TYPES,
  CashbookEntry,
  type CashbookScope,
  type CashbookType,
} from '../../database/entities/cashbook-entry.entity';
import { Device } from '../../database/entities/device.entity';
import { Organization } from '../../database/entities/organization.entity';
import { User } from '../../database/entities/user.entity';
import { TseSigningService } from '../tse/tse-signing.service';
import { rowsOf } from '../tse/tse-sql.util';
import type { TseReceiptView } from '../tse/tse-view';
import { CASHBOOK_LINES } from './dsfinvk-builder';
import {
  businessDateOf,
  businessDayRange,
  isBusinessDate,
} from './dsfinvk-master';

/** Hoechstbetrag einer Kassenbuch-Buchung (Tippfehler abfangen). */
const MAX_AMOUNT_CENTS = 100_000_00;

export interface CashbookEntryView {
  id: string;
  businessDate: string;
  type: CashbookType;
  /** DSFinV-K-Geschaeftsvorfall (Anfangsbestand, Geldtransit, DifferenzSollIst). */
  businessCase: string;
  /** Bargeldbewegung in Euro (Entnahme negativ, Kassensturz = Differenz). */
  amount: number;
  countedAmount: number | null;
  expectedAmount: number | null;
  scope: CashbookScope;
  note: string | null;
  deviceId: string | null;
  deviceName: string | null;
  userId: string | null;
  userName: string | null;
  tseTransactionId: string | null;
  createdAt: string;
}

/** Soll-Bestand und seine Bestandteile (Euro). */
export interface CashSummary {
  openingBalance: number;
  deposits: number;
  withdrawals: number;
  cashSales: number;
  cashRefunds: number;
  pfandPayouts: number;
  differences: number;
  /** Soll-Bestand = Summe aller Bargeldbewegungen des Geschaeftstags. */
  expected: number;
  lastCount: { at: string; counted: number; difference: number } | null;
}

export interface CashbookDay {
  businessDate: string;
  from: string;
  to: string;
  cashAllowed: boolean;
  tseActive: boolean;
  entries: CashbookEntryView[];
  total: CashSummary;
  /**
   * Vorschlag fuer den Anfangsbestand: zuletzt gezaehlter Bestand vor diesem
   * Geschaeftstag (Restbestand aus dem Vorabschluss). Anfangsbestand ist nur
   * Bargeld, das bei der Eroeffnung schon in der Kasse liegt; Wechselgeld
   * aus der Vereinskasse ist `deposit` = Geldtransit (Steuerberater
   * 2026-11-10, Frage 6). null = kein frueherer Kassensturz.
   */
  openingBalanceSuggestion: { amount: number; fromBusinessDate: string } | null;
  devices: {
    deviceId: string | null;
    deviceName: string | null;
    summary: CashSummary;
  }[];
}

const euros = (cents: number) => Math.round(cents) / 100;

/** Ganze Kasse (alle Geraete und Buchungen ohne Geraet). */
export const ALL_DEVICES = '*';
/** `ALL_DEVICES`, eine Geraete-ID oder `null` = nur Buchungen ohne Geraet (Verwaltung). */
type DeviceFilter = string | null;
const toCents = (value: unknown) => Math.round(Number(value ?? 0) * 100);

/**
 * Kassenbuch je Geschaeftstag (6–6 Uhr): Anfangsbestand (nur Restbestand
 * aus dem Vorabschluss, der bei Eroeffnung schon in der Kasse liegt),
 * Wechselgeld aus der Vereinskasse und Abschoepfung an die Vereinskasse
 * (Geldtransit, Schluessel 5 — eine Privateinlage gibt es beim e. V. nicht;
 * Steuerberater 2026-11-10, Frage 6), Kassensturz mit
 * Differenz (DifferenzSollIst). Jede Bargeldbewegung ist ein eigener,
 * TSE-gesicherter Beleg (Kassenbeleg-V1) und steht damit im
 * DSFinV-K-Kassenabschluss. Nur, wo Bargeld erlaubt ist.
 *
 * Soll-Bestand je Geraet (Schublade) oder fuer die ganze Kasse: Summe aus
 * Kassenbuch, Barzahlungen, Bar-Erstattungen und Pfand-Auszahlungen des
 * Geschaeftstags (ohne Testbuchungen).
 */
@Injectable()
export class CashbookService {
  private readonly logger = new Logger(CashbookService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(CashbookEntry)
    private readonly entryRepository: Repository<CashbookEntry>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    private readonly signing: TseSigningService,
  ) {}

  async create(
    organizationId: string,
    input: {
      type: string;
      amount: number;
      note?: string | null;
      scope?: CashbookScope;
    },
    actor: {
      deviceId?: string | null;
      userId?: string | null;
      waiterId?: string | null;
    },
  ): Promise<{
    entry: CashbookEntryView;
    tse: TseReceiptView | null;
    summary: CashSummary;
  }> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    assertCashAllowed(organization);
    if (!(CASHBOOK_TYPES as readonly string[]).includes(input.type)) {
      throw new BadRequestException({
        code: ErrorCodes.CASHBOOK_TYPE_INVALID,
        message: 'Unbekannte Kassenbuch-Buchung',
      });
    }
    const type = input.type as CashbookType;
    const value = toCents(input.amount);
    if (
      !Number.isFinite(Number(input.amount)) ||
      value < 0 ||
      value > MAX_AMOUNT_CENTS ||
      (type !== 'cash_count' && type !== 'opening_balance' && value === 0)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.CASHBOOK_AMOUNT_INVALID,
        message: 'Bitte gib einen gültigen Betrag an',
      });
    }
    // An einem Geraet gilt die Schublade des Geraets, in der Verwaltung die ganze Kasse.
    const scope: CashbookScope = actor.deviceId
      ? (input.scope ?? 'device')
      : 'register';
    const deviceId = actor.deviceId ?? null;
    const businessDate = businessDateOf(new Date());
    const note = (input.note ?? '').trim().slice(0, 500) || null;

    let amountCents = value;
    let expectedCents: number | null = null;
    if (type === 'withdrawal') amountCents = -value;
    if (type === 'cash_count') {
      expectedCents = (
        await this.summary(
          organizationId,
          businessDate,
          scope === 'device' && deviceId ? deviceId : ALL_DEVICES,
        )
      ).expectedCents;
      amountCents = value - expectedCents;
    }

    const entry = await this.entryRepository.save(
      this.entryRepository.create({
        organizationId,
        businessDate,
        type,
        amount: (amountCents / 100).toFixed(2),
        countedAmount: type === 'cash_count' ? (value / 100).toFixed(2) : null,
        expectedAmount:
          expectedCents !== null ? (expectedCents / 100).toFixed(2) : null,
        scope,
        note,
        deviceId,
        userId: actor.userId ?? null,
        waiterId: actor.waiterId ?? null,
      }),
    );

    let tse: TseReceiptView | null = null;
    if (amountCents !== 0) {
      tse = await this.signing.signCashbook({
        organizationId,
        entryId: entry.id,
        cashbookType: type,
        amountCents,
        note,
        terminal: deviceId,
        userId: actor.userId ?? null,
        waiterId: actor.waiterId ?? null,
      });
      if (tse) {
        entry.tseTransactionId = tse.id;
        await this.entryRepository.update(entry.id, {
          tseTransactionId: tse.id,
        });
      }
    }
    const summary = await this.summary(
      organizationId,
      businessDate,
      scope === 'device' && deviceId ? deviceId : ALL_DEVICES,
    );
    const [view] = await this.views([entry]);
    return { entry: view, tse, summary: summary.view };
  }

  async day(
    organizationId: string,
    businessDate?: string,
    deviceId?: string | null,
  ): Promise<CashbookDay> {
    // Auch geloeschte (Export bis zur endgueltigen Loeschung, AGB 10.4).
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
      withDeleted: true,
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    const date = isBusinessDate(businessDate)
      ? businessDate
      : businessDateOf(new Date());
    const range = businessDayRange(date);
    const entries = await this.entryRepository.find({
      where: {
        organizationId,
        businessDate: date,
        ...(deviceId ? { deviceId } : {}),
      },
      order: { createdAt: 'ASC' },
    });
    const total = await this.summary(
      organizationId,
      date,
      deviceId ?? ALL_DEVICES,
    );
    const devices: CashbookDay['devices'] = [];
    if (!deviceId) {
      for (const id of await this.devicesWithCash(organizationId, date)) {
        devices.push({
          deviceId: id,
          deviceName: null,
          summary: (await this.summary(organizationId, date, id)).view,
        });
      }
      const names = await this.dataSource.getRepository(Device).find({
        where: {
          id: In(
            devices.map((d) => d.deviceId).filter((x): x is string => !!x),
          ),
        },
        select: { id: true, name: true },
      });
      for (const d of devices)
        d.deviceName = names.find((n) => n.id === d.deviceId)?.name ?? null;
    }
    return {
      businessDate: date,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      cashAllowed: isCashAllowed(organization),
      tseActive: organization.tseActive === true,
      entries: await this.views(entries),
      total: total.view,
      openingBalanceSuggestion: await this.lastCountBefore(
        organizationId,
        date,
        deviceId ?? ALL_DEVICES,
      ),
      devices,
    };
  }

  /**
   * Zuletzt gezaehlter Bestand vor `businessDate` (je Geraet der letzte
   * Kassensturz; ganze Kasse = Summe ueber die Geraete).
   */
  async lastCountBefore(
    organizationId: string,
    businessDate: string,
    deviceId: DeviceFilter,
  ): Promise<{ amount: number; fromBusinessDate: string } | null> {
    const byDevice = deviceId !== ALL_DEVICES;
    const rows = rowsOf<{ total: string | null; last: string | null }>(
      await this.dataSource.query(
        `SELECT SUM(counted_amount) AS total, MAX(business_date)::text AS last
           FROM (
             SELECT DISTINCT ON (device_id) device_id, counted_amount, business_date
               FROM cashbook_entries
              WHERE organization_id = $1 AND type = 'cash_count'
                AND business_date < $2
                ${byDevice ? 'AND device_id IS NOT DISTINCT FROM $3' : ''}
              ORDER BY device_id, business_date DESC, created_at DESC
           ) latest`,
        byDevice
          ? [organizationId, businessDate, deviceId]
          : [organizationId, businessDate],
      ),
    );
    const row = rows[0];
    if (!row?.last) return null;
    return {
      amount: Math.round(Number(row.total ?? 0) * 100) / 100,
      fromBusinessDate: String(row.last).slice(0, 10),
    };
  }

  private async devicesWithCash(
    organizationId: string,
    businessDate: string,
  ): Promise<(string | null)[]> {
    const { from, to } = businessDayRange(businessDate);
    const rows = rowsOf<{ device_id: string | null }>(
      await this.dataSource.query(
        `SELECT DISTINCT device_id FROM (
         SELECT p.processed_by_device_id AS device_id FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.organization_id = $1 AND p.payment_method = 'cash' AND p.created_at >= $2 AND p.created_at < $3
         UNION SELECT device_id FROM refunds WHERE organization_id = $1 AND payment_method = 'cash' AND created_at >= $2 AND created_at < $3
         UNION SELECT device_id FROM pfand_returns WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3
         UNION SELECT device_id FROM cashbook_entries WHERE organization_id = $1 AND business_date = $4
       ) d`,
        [organizationId, from, to, businessDate],
      ),
    );
    return rows
      .map((r) => r.device_id)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  }

  /** Soll-Bestand eines Geschaeftstags (Geraet oder ganze Kasse). */
  async summary(
    organizationId: string,
    businessDate: string,
    deviceId: DeviceFilter,
  ): Promise<{ expectedCents: number; view: CashSummary }> {
    const { from, to } = businessDayRange(businessDate);
    const params: unknown[] = [organizationId, from, to];
    const byDevice = deviceId !== ALL_DEVICES && deviceId !== null;
    const device = (column: string) => {
      if (deviceId === ALL_DEVICES) return '';
      if (deviceId === null) return ` AND ${column} IS NULL`;
      return ` AND ${column} = $4`;
    };
    if (byDevice) params.push(deviceId);
    const [sales] = rowsOf<{ v: string }>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.organization_id = $1 AND o.is_test = false AND p.payment_method = 'cash'
          AND p.status IN ('captured', 'refunded') AND p.created_at >= $2 AND p.created_at < $3${device('p.processed_by_device_id')}`,
        params,
      ),
    );
    const [refunds] = rowsOf<{ v: string }>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(amount), 0) AS v FROM refunds
        WHERE organization_id = $1 AND is_test = false AND payment_method = 'cash'
          AND status IN ('completed', 'manual') AND created_at >= $2 AND created_at < $3${device('device_id')}`,
        params,
      ),
    );
    const [pfand] = rowsOf<{ v: string }>(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS v FROM pfand_returns
        WHERE organization_id = $1 AND is_test = false AND created_at >= $2 AND created_at < $3${device('device_id')}`,
        params,
      ),
    );
    const entryParams: unknown[] = [organizationId, businessDate];
    if (byDevice) entryParams.push(deviceId);
    const entries = rowsOf<{
      type: CashbookType;
      amount: string;
      counted_amount: string | null;
      created_at: Date;
    }>(
      await this.dataSource.query(
        `SELECT type, amount, counted_amount, created_at FROM cashbook_entries
        WHERE organization_id = $1 AND business_date = $2${
          deviceId === ALL_DEVICES
            ? ''
            : deviceId === null
              ? ' AND device_id IS NULL'
              : ' AND device_id = $3'
        }
        ORDER BY created_at`,
        entryParams,
      ),
    );

    const sum = (type: CashbookType, sign?: 1 | -1) =>
      entries
        .filter(
          (e) =>
            e.type === type && (!sign || Math.sign(toCents(e.amount)) === sign),
        )
        .reduce((s, e) => s + toCents(e.amount), 0);
    const opening = sum('opening_balance');
    const deposits = sum('deposit');
    const withdrawals = sum('withdrawal');
    const differences = sum('cash_count');
    const cashSales = toCents(sales?.v);
    const cashRefunds = toCents(refunds?.v); // negativ
    const pfandPayouts = -Math.abs(toCents(pfand?.v));
    const expected =
      opening +
      deposits +
      withdrawals +
      differences +
      cashSales +
      cashRefunds +
      pfandPayouts;
    const lastCount = [...entries]
      .reverse()
      .find((e) => e.type === 'cash_count');
    return {
      expectedCents: expected,
      view: {
        openingBalance: euros(opening),
        deposits: euros(deposits),
        withdrawals: euros(withdrawals),
        cashSales: euros(cashSales),
        cashRefunds: euros(cashRefunds),
        pfandPayouts: euros(pfandPayouts),
        differences: euros(differences),
        expected: euros(expected),
        lastCount: lastCount
          ? {
              at: new Date(lastCount.created_at).toISOString(),
              counted: euros(toCents(lastCount.counted_amount)),
              difference: euros(toCents(lastCount.amount)),
            }
          : null,
      },
    };
  }

  private async views(entries: CashbookEntry[]): Promise<CashbookEntryView[]> {
    const deviceIds = [
      ...new Set(
        entries.map((e) => e.deviceId).filter((d): d is string => !!d),
      ),
    ];
    const userIds = [
      ...new Set(entries.map((e) => e.userId).filter((u): u is string => !!u)),
    ];
    const devices = deviceIds.length
      ? await this.dataSource.getRepository(Device).find({
          where: { id: In(deviceIds) },
          select: { id: true, name: true },
        })
      : [];
    const users = userIds.length
      ? await this.dataSource.getRepository(User).find({
          where: { id: In(userIds) },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    return entries.map((e) => {
      const user = users.find((u) => u.id === e.userId);
      return {
        id: e.id,
        businessDate: e.businessDate,
        type: e.type,
        businessCase: CASHBOOK_LINES[e.type]?.gvTyp ?? '',
        amount: Number(e.amount),
        countedAmount:
          e.countedAmount !== null ? Number(e.countedAmount) : null,
        expectedAmount:
          e.expectedAmount !== null ? Number(e.expectedAmount) : null,
        scope: e.scope,
        note: e.note,
        deviceId: e.deviceId,
        deviceName: devices.find((d) => d.id === e.deviceId)?.name ?? null,
        userId: e.userId,
        userName: user
          ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || null
          : null,
        tseTransactionId: e.tseTransactionId,
        createdAt: e.createdAt.toISOString(),
      };
    });
  }
}
