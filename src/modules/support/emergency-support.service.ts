import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import {
  EVENT_UNLOCKED_BILLING_STATUSES,
  Event,
  EventStatus,
} from '../../database/entities/event.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { EventPhaseService } from '../events/event-phase.service';
import {
  EmergencySupportInfo,
  NO_EMERGENCY_SUPPORT,
  emergencyPhoneTelUri,
  isEmergencySupportEvent,
  normalizeEmergencyPhone,
} from './emergency-support';

/**
 * Notfall-Support (AGB 18.2): Rufnummer fuer eine Organisation, solange sie
 * eine gebuchte, noch nicht beendete Veranstaltung hat. Regeln in
 * emergency-support.ts. Wer fragen darf (Mitglied, Geraet), prueft der
 * Controller.
 */
@Injectable()
export class EmergencySupportService {
  readonly phone: string | null;

  constructor(
    configService: ConfigService,
    private readonly deployment: DeploymentService,
    private readonly eventPhase: EventPhaseService,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
  ) {
    this.phone = normalizeEmergencyPhone(
      configService.get<string>('OPERATOR_EMERGENCY_PHONE'),
    );
  }

  async forOrganization(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<EmergencySupportInfo> {
    // Ohne Rufnummer gar nicht erst in die Datenbank.
    if (!this.phone) return NO_EMERGENCY_SUPPORT;

    const billingEnabled = this.deployment.billingEnabled;
    const events = await this.eventRepository.find({
      where: billingEnabled
        ? {
            organizationId,
            status: Not(EventStatus.TEST),
            billingStatus: In([...EVENT_UNLOCKED_BILLING_STATUSES]),
          }
        : { organizationId, status: EventStatus.ACTIVE },
      select: {
        id: true,
        status: true,
        billingStatus: true,
        startDate: true,
        endDate: true,
        settings: true,
      },
    });
    if (!events.length) return NO_EMERGENCY_SUPPORT;

    const organization = await this.eventPhase.loadOrganization(organizationId);
    const eventIds = events
      .filter((event) =>
        isEmergencySupportEvent(
          event,
          this.eventPhase.resolveWith(event, organization, now),
          { billingEnabled },
          now,
        ),
      )
      .map((event) => event.id);
    if (!eventIds.length) return NO_EMERGENCY_SUPPORT;

    return {
      phone: this.phone,
      telUri: emergencyPhoneTelUri(this.phone),
      eventIds,
    };
  }
}
