import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  ContactRequest,
  Device,
  Event,
  Order,
  Organization,
  RentalAssignment,
  SupportMessage,
  User,
} from '../../database/entities';
import {
  Kennzahlen,
  LISTEN_LAENGE,
  VORSCHAU_LAENGE,
  type Freischaltung,
  type Kontaktanfrage,
  type NeueOrganisation,
  type NeuerNutzer,
} from './monitoring.types';

/** Billing states where money has actually been paid or is being paid. */
const PAID_OR_INVOICED = ['paid', 'invoice'];

/**
 * A row returned by `getRawOne`. Postgres returns COUNT (bigint) and SUM
 * over numeric as text so that no precision is lost.
 */
type Row<K extends string> = Record<K, string | number | null>;

/** Text or number from the database as a number; missing value becomes 0. */
function toNumber(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

/**
 * Metrics for monitoring.
 *
 * Deliberately a dedicated endpoint instead of pointing at the admin
 * lists: a caller that polls every few minutes should not have to page
 * through user pages, and the lists are shaped for the UI — they change
 * their form whenever the UI changes.
 *
 * Next to the totals there are short lists of the most recent records. A
 * total alone only tells you THAT something changed; to report what
 * happened, a caller needs the individual record and an `id` to tell
 * whether it has already seen it.
 */
@Injectable()
export class MonitoringService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Collects all metrics over ONE connection, sequentially.
   *
   * Previously some thirty queries ran side by side via `Promise.all`.
   * Each of them wanted its own connection from the pool, and because the
   * monitor only polls every fifteen minutes, the pool had drained by
   * then: most of the time went into opening connections, not into the
   * queries (which take 1–9 ms each). Now one query per table combines
   * the numbers with `FILTER (WHERE …)`, and everything runs in a single
   * read-only transaction on one connection. That transaction also sees a
   * single snapshot of the database, so the numbers are consistent with
   * each other.
   */
  async kennzahlen(): Promise<Kennzahlen> {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.dataSource.transaction(async (m) => {
      /* Must come before the first query. Monitoring never writes. */
      await m.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      return this.collect(m, monthStart, dayStart, since24h);
    });
  }

  private async collect(
    m: EntityManager,
    monthStart: Date,
    dayStart: Date,
    since24h: Date,
  ): Promise<Kennzahlen> {
    /* Soft-deleted organizations, users and events (deleted_at) are
       filtered out by the QueryBuilder itself — just like `count()` did. */
    const orgs = await m
      .createQueryBuilder(Organization, 'o')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE o.createdAt >= :m)', 'recent')
      .setParameters({ m: monthStart })
      .getRawOne<Row<'total' | 'recent'>>();
    const latestOrgs = await m.find(Organization, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
    });

    const users = await m
      .createQueryBuilder(User, 'u')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE u.isActive = true)', 'active')
      .addSelect('COUNT(*) FILTER (WHERE u.createdAt >= :m)', 'recent')
      .setParameters({ m: monthStart })
      .getRawOne<Row<'total' | 'active' | 'recent'>>();
    const latestUsers = await m.find(User, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    /* Counts and revenue in one pass. Revenue = sum of the prices actually
       charged; "today" and "month" are based on the payment date. */
    const ev = await m
      .createQueryBuilder(Event, 'e')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE e.status = 'active')", 'active')
      .addSelect("COUNT(*) FILTER (WHERE e.status = 'test')", 'test')
      .addSelect("COUNT(*) FILTER (WHERE e.billingStatus = 'paid')", 'paid')
      .addSelect(
        "COUNT(*) FILTER (WHERE e.billingStatus = 'pending')",
        'pending',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE e.billingStatus = 'invoice')",
        'invoice',
      )
      .addSelect("COUNT(*) FILTER (WHERE e.billingStatus = 'waived')", 'waived')
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s)), 0)',
        'revenue_total',
      )
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s) AND e.paidAt >= :t), 0)',
        'revenue_today',
      )
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s) AND e.paidAt >= :m), 0)',
        'revenue_month',
      )
      .setParameters({
        s: PAID_OR_INVOICED,
        t: dayStart,
        m: monthStart,
      })
      .getRawOne<
        Row<
          | 'total'
          | 'active'
          | 'test'
          | 'paid'
          | 'pending'
          | 'invoice'
          | 'waived'
          | 'revenue_total'
          | 'revenue_today'
          | 'revenue_month'
        >
      >();

    const activations = await m
      .createQueryBuilder(Event, 'e')
      .leftJoinAndSelect('e.organization', 'org')
      .where('e.billingStatus IN (:...s)', { s: PAID_OR_INVOICED })
      /* By payment date, not creation date: what should be reported is
         the activation, and that happens later. */
      .orderBy('e.paidAt', 'DESC', 'NULLS LAST')
      .take(LISTEN_LAENGE)
      .getMany();

    const rentals = await m
      .createQueryBuilder(RentalAssignment, 'r')
      .select('COALESCE(SUM(r.totalAmount), 0)', 'revenue_total')
      .where("r.status IN ('confirmed','active','returned')")
      .getRawOne<Row<'revenue_total'>>();

    const contacts = await m
      .createQueryBuilder(ContactRequest, 'c')
      .select('COUNT(*) FILTER (WHERE c.handledAt IS NULL)', 'open')
      .addSelect('COUNT(*) FILTER (WHERE c.createdAt >= :g)', 'recent')
      .setParameters({ g: since24h })
      .getRawOne<Row<'open' | 'recent'>>();
    const latestContacts = await m.find(ContactRequest, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
    });

    /* Counted directly. Going through the support endpoint would mark the
       messages as read — monitoring must not change the state it observes. */
    const support = await m
      .createQueryBuilder(SupportMessage, 'sm')
      .select('COUNT(*) FILTER (WHERE sm.readByAdminAt IS NULL)', 'unread')
      .addSelect(
        'COUNT(DISTINCT sm.organizationId) FILTER (WHERE sm.readByAdminAt IS NULL)',
        'threads',
      )
      .addSelect('MAX(sm.createdAt)', 'latest')
      .where("sm.direction = 'inbound'")
      .getRawOne<
        Row<'unread' | 'threads'> & { latest: Date | string | null }
      >();

    const devices = await m
      .createQueryBuilder(Device, 'd')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE d.status = 'verified')", 'verified')
      .getRawOne<Row<'total' | 'verified'>>();

    const orders = await m
      .createQueryBuilder(Order, 'b')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE b.createdAt >= :g)', 'recent')
      .setParameters({ g: since24h })
      .getRawOne<Row<'total' | 'recent'>>();

    const eventsPaid = toNumber(ev?.paid);
    const eventsInvoiced = toNumber(ev?.invoice);

    return {
      erhobenAm: new Date().toISOString(),

      organisationen: {
        gesamt: toNumber(orgs?.total),
        neuImMonat: toNumber(orgs?.recent),
        letzte: latestOrgs.map((o) => this.toOrganization(o)),
      },

      nutzer: {
        gesamt: toNumber(users?.total),
        aktiv: toNumber(users?.active),
        neuImMonat: toNumber(users?.recent),
        letzte: latestUsers.map((u) => this.toUser(u)),
      },

      veranstaltungen: {
        gesamt: toNumber(ev?.total),
        aktiv: toNumber(ev?.active),
        imTest: toNumber(ev?.test),
        bezahlt: eventsPaid,
        pending: toNumber(ev?.pending),
        aufRechnung: eventsInvoiced,
        erlassen: toNumber(ev?.waived),
        letzteFreischaltungen: activations.map((e) => this.toActivation(e)),
      },

      umsatz: {
        bezahlteVeranstaltungen: eventsPaid + eventsInvoiced,
        summeEur: toNumber(ev?.revenue_total),
        heuteEur: toNumber(ev?.revenue_today),
        monatEur: toNumber(ev?.revenue_month),
        mieteEur: toNumber(rentals?.revenue_total),
      },

      kontaktanfragen: {
        offen: toNumber(contacts?.open),
        neu24h: toNumber(contacts?.recent),
        letzte: latestContacts.map((a) => this.toContactRequest(a)),
      },

      support: {
        ungelesen: toNumber(support?.unread),
        threadsMitUngelesen: toNumber(support?.threads),
        letzteNachrichtAm: support?.latest
          ? new Date(support.latest).toISOString()
          : null,
      },

      geraete: {
        gesamt: toNumber(devices?.total),
        freigegeben: toNumber(devices?.verified),
      },
      bestellungen: {
        gesamt: toNumber(orders?.total),
        letzte24h: toNumber(orders?.recent),
      },
    };
  }

  private toOrganization(org: Organization): NeueOrganisation {
    return {
      id: org.id,
      name: org.name,
      erstelltAm: org.createdAt.toISOString(),
      billingMode: org.billingMode,
    };
  }

  private toUser(user: User): NeuerNutzer {
    return {
      id: user.id,
      erstelltAm: user.createdAt.toISOString(),
      vorname: user.firstName,
      nachnameInitial: user.lastName?.slice(0, 1) ?? '',
      organisation: user.userOrganizations?.[0]?.organization?.name ?? null,
      emailBestaetigt: !!user.emailVerifiedAt,
    };
  }

  private toActivation(event: Event): Freischaltung {
    return {
      id: event.id,
      name: event.name,
      organisation: event.organization?.name ?? null,
      billingStatus: event.billingStatus,
      preisEur: event.priceCharged === null ? null : Number(event.priceCharged),
      bezahltAm: event.paidAt?.toISOString() ?? null,
    };
  }

  private toContactRequest(request: ContactRequest): Kontaktanfrage {
    const text = request.message ?? '';
    return {
      id: request.id,
      erstelltAm: request.createdAt.toISOString(),
      typ: request.type,
      name: request.name,
      organisation: request.organization ?? null,
      vorschau:
        text.length > VORSCHAU_LAENGE
          ? `${text.slice(0, VORSCHAU_LAENGE)}…`
          : text,
    };
  }
}
