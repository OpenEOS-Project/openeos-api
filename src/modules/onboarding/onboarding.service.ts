import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Category, Device, Event, Product, User } from '../../database/entities';
import { DeviceStatus } from '../../database/entities/device.entity';
import { OrganizationsService } from '../organizations/organizations.service';

/** Ein Schritt des Quick-Starts. */
export interface OnboardingStep {
  id: 'event' | 'activate' | 'categories' | 'products' | 'device';
  done: boolean;
  /** Wie viele Objekte es gibt — die Oberflaeche zeigt es neben dem Schritt. */
  count: number;
}

export interface OnboardingStatus {
  steps: OnboardingStep[];
  /** Erledigte Schritte, fuer den Fortschrittsbalken. */
  completed: number;
  total: number;
  /** Die Veranstaltung, auf die sich die Schritte beziehen. */
  eventId: string | null;
}

/**
 * Fortschritt der Ersteinrichtung.
 *
 * Abgeleitet aus den echten Daten, nicht als eigener Haken gespeichert.
 * Ein mitgefuehrter Zustand liefe frueher oder spaeter auseinander — wer
 * sein einziges Produkt wieder loescht, haette sonst weiterhin einen
 * gruenen Haken bei "Produkte angelegt".
 *
 * Bezugspunkt ist die zuletzt angelegte Veranstaltung. Kategorien und
 * Produkte haengen an einer Veranstaltung, nicht an der Organisation;
 * ohne Bezug waere "Produkte angelegt" nicht beantwortbar.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly organizationsService: OrganizationsService,
  ) {}

  async getStatus(organizationId: string, user: User): Promise<OnboardingStatus> {
    await this.organizationsService.checkPermission(organizationId, user, 'events');

    const events = await this.eventRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    /* Freigeschaltet zaehlt jede Veranstaltung, die bezahlt, auf Rechnung
       bestellt oder erlassen wurde — dieselben drei Zustaende, die auch
       das Aktivieren erlaubt. */
    const freigeschaltet = events.filter((e) =>
      ['paid', 'invoice', 'waived'].includes(e.billingStatus),
    );

    /* Die juengste freigeschaltete Veranstaltung ist der Bezugspunkt; gibt
       es keine, die juengste ueberhaupt. Sonst zeigte die Checkliste die
       Produkte eines Fests, das der Nutzer gerade gar nicht einrichtet. */
    const bezug = freigeschaltet[0] ?? events[0] ?? null;

    const [categories, products, devices] = await Promise.all([
      bezug ? this.categoryRepository.count({ where: { eventId: bezug.id } }) : 0,
      bezug ? this.productRepository.count({ where: { eventId: bezug.id } }) : 0,
      this.deviceRepository.count({
        where: { organizationId, status: In([DeviceStatus.VERIFIED]) },
      }),
    ]);

    const steps: OnboardingStep[] = [
      { id: 'event', done: events.length > 0, count: events.length },
      { id: 'activate', done: freigeschaltet.length > 0, count: freigeschaltet.length },
      { id: 'categories', done: categories > 0, count: categories },
      { id: 'products', done: products > 0, count: products },
      { id: 'device', done: devices > 0, count: devices },
    ];

    return {
      steps,
      completed: steps.filter((s) => s.done).length,
      total: steps.length,
      eventId: bezug?.id ?? null,
    };
  }
}
