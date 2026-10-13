import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EventStatus, Order } from '../../database/entities';

export const DEFAULT_WINDOW_MINUTES = 30;

export interface DeployGuardStatus {
  /** true: an event is selling right now — do not deploy. */
  busy: boolean;
  windowMinutes: number;
  checkedAt: string;
  events: { name: string; lastOrderAt: string }[];
}

/**
 * Is a festival running? "Running" means: an active event (not in test
 * mode) took a real order — not a test order — within the window. Events
 * that are switched on but quiet do not block a deploy.
 */
@Injectable()
export class DeployGuardService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
  ) {}

  async status(
    windowMinutes = DEFAULT_WINDOW_MINUTES,
    now = new Date(),
  ): Promise<DeployGuardStatus> {
    const since = new Date(now.getTime() - windowMinutes * 60_000);

    const rows = await this.orders
      .createQueryBuilder('o')
      .innerJoin('o.event', 'e')
      .select('e.name', 'name')
      .addSelect('MAX(o.createdAt)', 'lastOrderAt')
      .where('e.status = :status', { status: EventStatus.ACTIVE })
      .andWhere('e.deletedAt IS NULL')
      .andWhere('o.isTest = false')
      .andWhere('o.createdAt >= :since', { since })
      .groupBy('e.id')
      .addGroupBy('e.name')
      .orderBy('"lastOrderAt"', 'DESC')
      .getRawMany<{ name: string; lastOrderAt: Date | string }>();

    const events = rows.map((row) => ({
      name: row.name,
      lastOrderAt: new Date(row.lastOrderAt).toISOString(),
    }));

    return {
      busy: events.length > 0,
      windowMinutes,
      checkedAt: now.toISOString(),
      events,
    };
  }
}
