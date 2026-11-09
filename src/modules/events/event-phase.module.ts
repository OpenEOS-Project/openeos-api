import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../../database/entities/event.entity';
import { Order } from '../../database/entities/order.entity';
import { Organization } from '../../database/entities/organization.entity';
import { EventPhaseService } from './event-phase.service';

/**
 * Phasen einer Veranstaltung. Global, weil jede Stelle, an der eine
 * Bestellung entsteht (Kasse, Tische, QR, Shop, Verwaltung), sie fragen muss
 * — dieselbe Ueberlegung wie bei `DeploymentService` (CommonModule).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Event, Organization, Order])],
  providers: [EventPhaseService],
  exports: [EventPhaseService],
})
export class EventPhaseModule {}
