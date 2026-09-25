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

/** Bezahlzustände, bei denen tatsächlich Geld geflossen ist oder fließt. */
const BEZAHLT_ODER_RECHNUNG = ['paid', 'invoice'];

/**
 * Eine Zeile aus `getRawOne`. Postgres liefert COUNT (bigint) und SUM über
 * numeric als Text, damit nichts an Genauigkeit verloren geht.
 */
type Zeile<K extends string> = Record<K, string | number | null>;

/** Text oder Zahl aus der Datenbank als Zahl; fehlt der Wert, dann 0. */
function zahl(wert: string | number | null | undefined): number {
  return Number(wert ?? 0);
}

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
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Alle Kennzahlen über EINE Verbindung, nacheinander.
   *
   * Früher liefen gut dreißig Abfragen per `Promise.all` nebeneinander.
   * Jede wollte eine eigene Verbindung aus dem Pool, und weil der Monitor
   * nur alle Viertelstunde fragt, war der Pool bis dahin leer gelaufen:
   * Die meiste Zeit ging für den Aufbau von Verbindungen drauf, nicht für
   * die Abfragen (die brauchen je 1–9 ms). Jetzt fasst je Tabelle eine
   * Abfrage die Zahlen mit `FILTER (WHERE …)` zusammen, und alles läuft in
   * einer lesenden Transaktion auf einer Verbindung. Die sieht zudem einen
   * einzigen Stand der Datenbank, die Zahlen passen also zueinander.
   */
  async kennzahlen(): Promise<Kennzahlen> {
    const monatsbeginn = new Date();
    monatsbeginn.setDate(1);
    monatsbeginn.setHours(0, 0, 0, 0);

    const tagesbeginn = new Date();
    tagesbeginn.setHours(0, 0, 0, 0);

    const gestern = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.dataSource.transaction(async (m) => {
      /* Muss vor der ersten Abfrage stehen. Eine Überwachung schreibt nicht. */
      await m.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      return this.erheben(m, monatsbeginn, tagesbeginn, gestern);
    });
  }

  private async erheben(
    m: EntityManager,
    monatsbeginn: Date,
    tagesbeginn: Date,
    gestern: Date,
  ): Promise<Kennzahlen> {
    /* Gelöschte Organisationen, Nutzer und Veranstaltungen (deleted_at)
       blendet der QueryBuilder selbst aus — genau wie zuvor `count()`. */
    const org = await m
      .createQueryBuilder(Organization, 'o')
      .select('COUNT(*)', 'gesamt')
      .addSelect('COUNT(*) FILTER (WHERE o.createdAt >= :m)', 'neu')
      .setParameters({ m: monatsbeginn })
      .getRawOne<Zeile<'gesamt' | 'neu'>>();
    const orgLetzte = await m.find(Organization, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
    });

    const nutzer = await m
      .createQueryBuilder(User, 'u')
      .select('COUNT(*)', 'gesamt')
      .addSelect('COUNT(*) FILTER (WHERE u.isActive = true)', 'aktiv')
      .addSelect('COUNT(*) FILTER (WHERE u.createdAt >= :m)', 'neu')
      .setParameters({ m: monatsbeginn })
      .getRawOne<Zeile<'gesamt' | 'aktiv' | 'neu'>>();
    const nutzerLetzte = await m.find(User, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
      relations: ['userOrganizations', 'userOrganizations.organization'],
    });

    /* Zählungen und Umsatz in einem Durchgang. Umsatz = Summe der
       tatsächlich berechneten Preise; „heute“ und „Monat“ nach Bezahldatum. */
    const ev = await m
      .createQueryBuilder(Event, 'e')
      .select('COUNT(*)', 'gesamt')
      .addSelect("COUNT(*) FILTER (WHERE e.status = 'active')", 'aktiv')
      .addSelect("COUNT(*) FILTER (WHERE e.status = 'test')", 'test')
      .addSelect("COUNT(*) FILTER (WHERE e.billingStatus = 'paid')", 'bezahlt')
      .addSelect(
        "COUNT(*) FILTER (WHERE e.billingStatus = 'pending')",
        'pending',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE e.billingStatus = 'invoice')",
        'rechnung',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE e.billingStatus = 'waived')",
        'erlassen',
      )
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s)), 0)',
        'summe',
      )
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s) AND e.paidAt >= :t), 0)',
        'heute',
      )
      .addSelect(
        'COALESCE(SUM(e.priceCharged) FILTER (WHERE e.billingStatus IN (:...s) AND e.paidAt >= :m), 0)',
        'monat',
      )
      .setParameters({
        s: BEZAHLT_ODER_RECHNUNG,
        t: tagesbeginn,
        m: monatsbeginn,
      })
      .getRawOne<
        Zeile<
          | 'gesamt'
          | 'aktiv'
          | 'test'
          | 'bezahlt'
          | 'pending'
          | 'rechnung'
          | 'erlassen'
          | 'summe'
          | 'heute'
          | 'monat'
        >
      >();

    const freischaltungen = await m
      .createQueryBuilder(Event, 'e')
      .leftJoinAndSelect('e.organization', 'org')
      .where('e.billingStatus IN (:...s)', { s: BEZAHLT_ODER_RECHNUNG })
      /* Nach Bezahldatum, nicht nach Anlagedatum: gemeldet werden soll
         die Freischaltung, und die passiert spaeter. */
      .orderBy('e.paidAt', 'DESC', 'NULLS LAST')
      .take(LISTEN_LAENGE)
      .getMany();

    const miete = await m
      .createQueryBuilder(RentalAssignment, 'r')
      .select('COALESCE(SUM(r.totalAmount), 0)', 'summe')
      .where("r.status IN ('confirmed','active','returned')")
      .getRawOne<Zeile<'summe'>>();

    const anfragen = await m
      .createQueryBuilder(ContactRequest, 'c')
      .select('COUNT(*) FILTER (WHERE c.handledAt IS NULL)', 'offen')
      .addSelect('COUNT(*) FILTER (WHERE c.createdAt >= :g)', 'neu')
      .setParameters({ g: gestern })
      .getRawOne<Zeile<'offen' | 'neu'>>();
    const anfragenLetzte = await m.find(ContactRequest, {
      order: { createdAt: 'DESC' },
      take: LISTEN_LAENGE,
    });

    /* Direkt gezaehlt. Der Weg ueber den Support-Endpunkt wuerde die
       Nachrichten dabei als gelesen markieren — eine Ueberwachung darf
       den Zustand nicht veraendern, den sie beobachtet. */
    const support = await m
      .createQueryBuilder(SupportMessage, 'sm')
      .select('COUNT(*) FILTER (WHERE sm.readByAdminAt IS NULL)', 'ungelesen')
      .addSelect(
        'COUNT(DISTINCT sm.organizationId) FILTER (WHERE sm.readByAdminAt IS NULL)',
        'threads',
      )
      .addSelect('MAX(sm.createdAt)', 'letzte')
      .where("sm.direction = 'inbound'")
      .getRawOne<
        Zeile<'ungelesen' | 'threads'> & { letzte: Date | string | null }
      >();

    const geraete = await m
      .createQueryBuilder(Device, 'd')
      .select('COUNT(*)', 'gesamt')
      .addSelect("COUNT(*) FILTER (WHERE d.status = 'verified')", 'frei')
      .getRawOne<Zeile<'gesamt' | 'frei'>>();

    const bestellungen = await m
      .createQueryBuilder(Order, 'b')
      .select('COUNT(*)', 'gesamt')
      .addSelect('COUNT(*) FILTER (WHERE b.createdAt >= :g)', 'neu')
      .setParameters({ g: gestern })
      .getRawOne<Zeile<'gesamt' | 'neu'>>();

    const eventBezahlt = zahl(ev?.bezahlt);
    const eventRechnung = zahl(ev?.rechnung);

    return {
      erhobenAm: new Date().toISOString(),

      organisationen: {
        gesamt: zahl(org?.gesamt),
        neuImMonat: zahl(org?.neu),
        letzte: orgLetzte.map((o) => this.alsOrganisation(o)),
      },

      nutzer: {
        gesamt: zahl(nutzer?.gesamt),
        aktiv: zahl(nutzer?.aktiv),
        neuImMonat: zahl(nutzer?.neu),
        letzte: nutzerLetzte.map((u) => this.alsNutzer(u)),
      },

      veranstaltungen: {
        gesamt: zahl(ev?.gesamt),
        aktiv: zahl(ev?.aktiv),
        imTest: zahl(ev?.test),
        bezahlt: eventBezahlt,
        pending: zahl(ev?.pending),
        aufRechnung: eventRechnung,
        erlassen: zahl(ev?.erlassen),
        letzteFreischaltungen: freischaltungen.map((e) =>
          this.alsFreischaltung(e),
        ),
      },

      umsatz: {
        bezahlteVeranstaltungen: eventBezahlt + eventRechnung,
        summeEur: zahl(ev?.summe),
        heuteEur: zahl(ev?.heute),
        monatEur: zahl(ev?.monat),
        mieteEur: zahl(miete?.summe),
      },

      kontaktanfragen: {
        offen: zahl(anfragen?.offen),
        neu24h: zahl(anfragen?.neu),
        letzte: anfragenLetzte.map((a) => this.alsKontaktanfrage(a)),
      },

      support: {
        ungelesen: zahl(support?.ungelesen),
        threadsMitUngelesen: zahl(support?.threads),
        letzteNachrichtAm: support?.letzte
          ? new Date(support.letzte).toISOString()
          : null,
      },

      geraete: {
        gesamt: zahl(geraete?.gesamt),
        freigegeben: zahl(geraete?.frei),
      },
      bestellungen: {
        gesamt: zahl(bestellungen?.gesamt),
        letzte24h: zahl(bestellungen?.neu),
      },
    };
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
      vorschau:
        text.length > VORSCHAU_LAENGE
          ? `${text.slice(0, VORSCHAU_LAENGE)}…`
          : text,
    };
  }
}
