import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Device, Event, Order, Organization, User } from '../../database/entities';

export interface Kennzahlen {
  /** Zeitpunkt der Erhebung — der Abrufer weiss so, wie frisch die Zahlen sind. */
  erhobenAm: string;
  organisationen: { gesamt: number; neuImMonat: number };
  nutzer: { gesamt: number; aktiv: number; neuImMonat: number };
  veranstaltungen: { gesamt: number; aktiv: number; imTest: number; bezahlt: number };
  /** Was OpenEOS eingenommen hat (Freischaltungen), nicht der Umsatz der Kunden. */
  umsatz: { bezahlteVeranstaltungen: number; summeEur: number };
  geraete: { gesamt: number; freigegeben: number };
  bestellungen: { gesamt: number; letzte24h: number };
}

/**
 * Kennzahlen für die Überwachung.
 *
 * Bewusst ein eigener Endpunkt statt eines Verweises auf die
 * Admin-Listen: Wer alle fünf Minuten fragt, soll nicht durch
 * Nutzerseiten blättern, und die Listen sind auf die Oberfläche
 * zugeschnitten — sie ändern ihre Form, sobald sich die Oberfläche
 * ändert. Hier sind es Zahlen, keine Datensätze, und es verlässt
 * niemandes Namen das Haus.
 */
@Injectable()
export class MonitoringService {
  constructor(
    @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  async kennzahlen(): Promise<Kennzahlen> {
    const monatsbeginn = new Date();
    monatsbeginn.setDate(1);
    monatsbeginn.setHours(0, 0, 0, 0);

    const gestern = new Date(Date.now() - 24 * 60 * 60 * 1000);

    /* Alles nebeneinander: nacheinander waeren es ein Dutzend Rundreisen
       zur Datenbank fuer eine Antwort, die jemand im Minutentakt holt. */
    const [
      orgGesamt,
      orgNeu,
      nutzerGesamt,
      nutzerAktiv,
      nutzerNeu,
      eventGesamt,
      eventAktiv,
      eventTest,
      eventBezahlt,
      geraeteGesamt,
      geraeteFrei,
      bestellGesamt,
      bestell24h,
      umsatz,
    ] = await Promise.all([
      this.organizations.count(),
      this.organizations.createQueryBuilder('o').where('o.createdAt >= :m', { m: monatsbeginn }).getCount(),
      this.users.count(),
      this.users.count({ where: { isActive: true } }),
      this.users.createQueryBuilder('u').where('u.createdAt >= :m', { m: monatsbeginn }).getCount(),
      this.events.count(),
      this.events.count({ where: { status: 'active' as never } }),
      this.events.count({ where: { status: 'test' as never } }),
      this.events.createQueryBuilder('e').where("e.billingStatus IN ('paid','invoice')").getCount(),
      this.devices.count(),
      this.devices.count({ where: { status: 'verified' as never } }),
      this.orders.count(),
      this.orders.createQueryBuilder('o').where('o.createdAt >= :g', { g: gestern }).getCount(),
      this.events
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.priceCharged), 0)', 'summe')
        .where("e.billingStatus IN ('paid','invoice')")
        .getRawOne<{ summe: string }>(),
    ]);

    return {
      erhobenAm: new Date().toISOString(),
      organisationen: { gesamt: orgGesamt, neuImMonat: orgNeu },
      nutzer: { gesamt: nutzerGesamt, aktiv: nutzerAktiv, neuImMonat: nutzerNeu },
      veranstaltungen: { gesamt: eventGesamt, aktiv: eventAktiv, imTest: eventTest, bezahlt: eventBezahlt },
      umsatz: { bezahlteVeranstaltungen: eventBezahlt, summeEur: Number(umsatz?.summe ?? 0) },
      geraete: { gesamt: geraeteGesamt, freigegeben: geraeteFrei },
      bestellungen: { gesamt: bestellGesamt, letzte24h: bestell24h },
    };
  }
}
