import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

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

/** Bezahlzustände, bei denen tatsächlich Geld geflossen ist oder fließt. */
const BEZAHLT_ODER_RECHNUNG = ['paid', 'invoice'];

/**
 * Kennzahlen für die Überwachung.
 *
 * Bewusst ein eigener Endpunkt statt eines Verweises auf die
 * Admin-Listen: Wer alle fünf Minuten fragt, soll nicht durch
 * Nutzerseiten blättern, und die Listen sind auf die Oberfläche
 * zugeschnitten — sie ändern ihre Form, sobald sich die Oberfläche
 * ändert.
 *
 * Neben den Summen stehen kurze Listen der jüngsten Vorgänge. Eine Summe
 * allein sagt nur, DASS sich etwas geändert hat; wer melden will, was
 * passiert ist, braucht den einzelnen Vorgang und eine `id`, an der er
 * erkennt, ob er ihn schon kennt.
 */
@Injectable()
export class MonitoringService {
  constructor(
    @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(ContactRequest) private readonly contactRequests: Repository<ContactRequest>,
    @InjectRepository(SupportMessage) private readonly supportMessages: Repository<SupportMessage>,
    @InjectRepository(RentalAssignment) private readonly rentals: Repository<RentalAssignment>,
  ) {}

  async kennzahlen(): Promise<Kennzahlen> {
    const monatsbeginn = new Date();
    monatsbeginn.setDate(1);
    monatsbeginn.setHours(0, 0, 0, 0);

    const tagesbeginn = new Date();
    tagesbeginn.setHours(0, 0, 0, 0);

    const gestern = new Date(Date.now() - 24 * 60 * 60 * 1000);

    /* Alles nebeneinander: nacheinander waeren es zwei Dutzend Rundreisen
       zur Datenbank fuer eine Antwort, die jemand im Minutentakt holt. */
    const [
      orgGesamt, orgNeu, orgLetzte,
      nutzerGesamt, nutzerAktiv, nutzerNeu, nutzerLetzte,
      eventGesamt, eventAktiv, eventTest, eventBezahlt, eventPending, eventRechnung, eventErlassen,
      freischaltungen,
      umsatzGesamt, umsatzHeute, umsatzMonat, mieteGesamt,
      anfragenOffen, anfragenNeu, anfragenLetzte,
      supportUngelesen, supportThreads, supportLetzte,
      geraeteGesamt, geraeteFrei,
      bestellGesamt, bestell24h,
    ] = await Promise.all([
      this.organizations.count(),
      this.organizations.createQueryBuilder('o').where('o.createdAt >= :m', { m: monatsbeginn }).getCount(),
      this.organizations.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

      this.users.count(),
      this.users.count({ where: { isActive: true } }),
      this.users.createQueryBuilder('u').where('u.createdAt >= :m', { m: monatsbeginn }).getCount(),
      this.users.find({
        order: { createdAt: 'DESC' },
        take: LISTEN_LAENGE,
        relations: ['userOrganizations', 'userOrganizations.organization'],
      }),

      this.events.count(),
      this.events.count({ where: { status: 'active' as never } }),
      this.events.count({ where: { status: 'test' as never } }),
      this.events.count({ where: { billingStatus: 'paid' as never } }),
      this.events.count({ where: { billingStatus: 'pending' as never } }),
      this.events.count({ where: { billingStatus: 'invoice' as never } }),
      this.events.count({ where: { billingStatus: 'waived' as never } }),

      this.events
        .createQueryBuilder('e')
        .leftJoinAndSelect('e.organization', 'org')
        .where('e.billingStatus IN (:...s)', { s: BEZAHLT_ODER_RECHNUNG })
        /* Nach Bezahldatum, nicht nach Anlagedatum: gemeldet werden soll
           die Freischaltung, und die passiert spaeter. */
        .orderBy('e.paidAt', 'DESC', 'NULLS LAST')
        .take(LISTEN_LAENGE)
        .getMany(),

      this.summe(BEZAHLT_ODER_RECHNUNG),
      this.summe(BEZAHLT_ODER_RECHNUNG, tagesbeginn),
      this.summe(BEZAHLT_ODER_RECHNUNG, monatsbeginn),
      this.rentals
        .createQueryBuilder('r')
        .select('COALESCE(SUM(r.totalAmount), 0)', 'summe')
        .where("r.status IN ('confirmed','active','returned')")
        .getRawOne<{ summe: string }>(),

      this.contactRequests.count({ where: { handledAt: IsNull() } }),
      this.contactRequests.createQueryBuilder('c').where('c.createdAt >= :g', { g: gestern }).getCount(),
      this.contactRequests.find({ order: { createdAt: 'DESC' }, take: LISTEN_LAENGE }),

      /* Direkt gezaehlt. Der Weg ueber den Support-Endpunkt wuerde die
         Nachrichten dabei als gelesen markieren — eine Ueberwachung darf
         den Zustand nicht veraendern, den sie beobachtet. */
      this.supportMessages.count({ where: { direction: 'inbound', readByAdminAt: IsNull() } }),
      this.supportMessages
        .createQueryBuilder('m')
        .select('COUNT(DISTINCT m.organizationId)', 'anzahl')
        .where("m.direction = 'inbound' AND m.readByAdminAt IS NULL")
        .getRawOne<{ anzahl: string }>(),
      this.supportMessages.findOne({ where: { direction: 'inbound' }, order: { createdAt: 'DESC' } }),

      this.devices.count(),
      this.devices.count({ where: { status: 'verified' as never } }),

      this.orders.count(),
      this.orders.createQueryBuilder('o').where('o.createdAt >= :g', { g: gestern }).getCount(),
    ]);

    return {
      erhobenAm: new Date().toISOString(),

      organisationen: {
        gesamt: orgGesamt,
        neuImMonat: orgNeu,
        letzte: orgLetzte.map(this.alsOrganisation),
      },

      nutzer: {
        gesamt: nutzerGesamt,
        aktiv: nutzerAktiv,
        neuImMonat: nutzerNeu,
        letzte: nutzerLetzte.map(this.alsNutzer),
      },

      veranstaltungen: {
        gesamt: eventGesamt,
        aktiv: eventAktiv,
        imTest: eventTest,
        bezahlt: eventBezahlt,
        pending: eventPending,
        aufRechnung: eventRechnung,
        erlassen: eventErlassen,
        letzteFreischaltungen: freischaltungen.map(this.alsFreischaltung),
      },

      umsatz: {
        bezahlteVeranstaltungen: eventBezahlt + eventRechnung,
        summeEur: umsatzGesamt,
        heuteEur: umsatzHeute,
        monatEur: umsatzMonat,
        mieteEur: Number(mieteGesamt?.summe ?? 0),
      },

      kontaktanfragen: {
        offen: anfragenOffen,
        neu24h: anfragenNeu,
        letzte: anfragenLetzte.map(this.alsKontaktanfrage),
      },

      support: {
        ungelesen: supportUngelesen,
        threadsMitUngelesen: Number(supportThreads?.anzahl ?? 0),
        letzteNachrichtAm: supportLetzte?.createdAt?.toISOString() ?? null,
      },

      geraete: { gesamt: geraeteGesamt, freigegeben: geraeteFrei },
      bestellungen: { gesamt: bestellGesamt, letzte24h: bestell24h },
    };
  }

  /** Summe der tatsächlich berechneten Preise, optional ab einem Zeitpunkt. */
  private async summe(status: string[], ab?: Date): Promise<number> {
    const abfrage = this.events
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.priceCharged), 0)', 'summe')
      .where('e.billingStatus IN (:...s)', { s: status });

    if (ab) abfrage.andWhere('e.paidAt >= :ab', { ab });

    const zeile = await abfrage.getRawOne<{ summe: string }>();
    return Number(zeile?.summe ?? 0);
  }

  private alsOrganisation(org: Organization): NeueOrganisation {
    return {
      id: org.id,
      name: org.name,
      erstelltAm: org.createdAt.toISOString(),
      billingMode: org.billingMode,
    };
  }

  private alsNutzer(user: User): NeuerNutzer {
    return {
      id: user.id,
      erstelltAm: user.createdAt.toISOString(),
      vorname: user.firstName,
      nachnameInitial: user.lastName?.slice(0, 1) ?? '',
      organisation: user.userOrganizations?.[0]?.organization?.name ?? null,
      emailBestaetigt: !!user.emailVerifiedAt,
    };
  }

  private alsFreischaltung(event: Event): Freischaltung {
    return {
      id: event.id,
      name: event.name,
      organisation: event.organization?.name ?? null,
      billingStatus: event.billingStatus,
      preisEur: event.priceCharged === null ? null : Number(event.priceCharged),
      bezahltAm: event.paidAt?.toISOString() ?? null,
    };
  }

  private alsKontaktanfrage(anfrage: ContactRequest): Kontaktanfrage {
    const text = anfrage.message ?? '';
    return {
      id: anfrage.id,
      erstelltAm: anfrage.createdAt.toISOString(),
      typ: anfrage.type,
      name: anfrage.name,
      organisation: anfrage.organization ?? null,
      vorschau: text.length > VORSCHAU_LAENGE ? `${text.slice(0, VORSCHAU_LAENGE)}…` : text,
    };
  }
}
