import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { Event } from '../../database/entities';
import { EventStatus } from '../../database/entities/event.entity';
import { EventsService } from './events.service';

@Injectable()
export class EventLifecycleService {
  private readonly logger = new Logger(EventLifecycleService.name);

  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    private readonly eventsService: EventsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleEventLifecycleTransitions(): Promise<void> {
    const now = new Date();

    await this.transitionScheduledToActive(now);
    await this.transitionActiveToCompleted(now);
  }

  private async transitionScheduledToActive(now: Date): Promise<void> {
    const scheduledEvents = await this.eventRepository.find({
      where: {
        status: EventStatus.SCHEDULED,
        startDate: LessThanOrEqual(now),
      },
    });

    for (const event of scheduledEvents) {
      try {
        // Delete test orders before activating
        await this.eventsService.deleteTestOrders(event.id);

        event.status = EventStatus.ACTIVE;
        await this.eventRepository.save(event);

        this.logger.log(`Event lifecycle: SCHEDULED → ACTIVE: ${event.name} (${event.id})`);
      } catch (error) {
        this.logger.error(`Failed to transition event ${event.id} to ACTIVE: ${error.message}`);
      }
    }
  }

  private async transitionActiveToCompleted(now: Date): Promise<void> {
    const activeEvents = await this.eventRepository.find({
      where: {
        status: EventStatus.ACTIVE,
        endDate: LessThanOrEqual(now),
      },
    });

    for (const event of activeEvents) {
      try {
        event.status = EventStatus.COMPLETED;
        await this.eventRepository.save(event);

        this.logger.log(`Event lifecycle: ACTIVE → COMPLETED: ${event.name} (${event.id})`);
      } catch (error) {
        this.logger.error(`Failed to transition event ${event.id} to COMPLETED: ${error.message}`);
      }
    }
  }
}
