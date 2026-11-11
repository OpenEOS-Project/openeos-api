import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { TseOutage } from '../../database/entities/tse-outage.entity';
import { TseNotifyService } from './tse-notify.service';
import { rowsOf } from './tse-sql.util';

/**
 * Ausfallprotokoll (AEAO zu § 146a Nr. 1.14): Ein gescheiterter Vorgang
 * oeffnet einen Ausfall (falls keiner offen ist) und benachrichtigt die
 * Admins einmal; der naechste erfolgreiche Vorgang schliesst ihn.
 *
 * `maybeOpen` merkt sich je TSE, ob ein Ausfall offen sein koennte —
 * so kostet ein erfolgreicher Verkauf im Normalfall keine Abfrage. Beim
 * Start ist der Stand unbekannt (true). Ausfaelle, die eine andere Instanz
 * geoeffnet hat, schliesst spaetestens der Abgleich (TseReconcileService).
 */
/** Hoechstalter des Ausfall-Stands aus der Datenbank (andere Instanzen). */
const OPEN_CACHE_MS = 5_000;

@Injectable()
export class TseOutageService {
  private readonly logger = new Logger(TseOutageService.name);
  private readonly maybeOpen = new Map<string, boolean>();
  /** Kurzzeit-Cache fuer `isOpen` (je TSE), damit nicht jede Bestellung fragt. */
  private readonly openCache = new Map<string, { open: boolean; at: number }>();

  constructor(
    @InjectRepository(TseOutage)
    private readonly outageRepository: Repository<TseOutage>,
    private readonly notify: TseNotifyService,
  ) {}

  async recordFailure(
    organizationId: string,
    tseUnitId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    this.maybeOpen.set(tseUnitId, true);
    this.openCache.set(tseUnitId, { open: true, at: Date.now() });
    try {
      const inserted = rowsOf<{
        id: string;
        opened: boolean;
        notified_at: Date | null;
      }>(
        await this.outageRepository.query(
          `INSERT INTO tse_outages
           (organization_id, tse_unit_id, started_at, reason, last_error_message, failed_count)
         VALUES ($1, $2, now(), $3, $4, 1)
         ON CONFLICT (tse_unit_id) WHERE ended_at IS NULL
         DO UPDATE SET failed_count = tse_outages.failed_count + 1,
                       last_error_message = EXCLUDED.last_error_message,
                       updated_at = now()
         RETURNING id, (xmax = 0) AS opened, notified_at`,
          [
            organizationId,
            tseUnitId,
            errorCode.slice(0, 60),
            errorMessage.slice(0, 500),
          ],
        ),
      );
      const row = inserted[0];
      if (row?.opened) {
        this.logger.warn(
          `TSE outage opened for org ${organizationId} (unit ${tseUnitId}): ${errorCode}`,
        );
        this.notify.statusChanged(organizationId, {
          state: 'error',
          outage: true,
          reason: errorCode,
        });
      }
      if (row && !row.notified_at) {
        // Einmal je Ausfall: zuerst markieren, dann senden (mehrere
        // Instanzen schicken so keine doppelten Mails).
        const claimed = rowsOf<{ id: string }>(
          await this.outageRepository.query(
            `UPDATE tse_outages SET notified_at = now()
              WHERE id = $1 AND notified_at IS NULL RETURNING id`,
            [row.id],
          ),
        );
        if (claimed.length > 0) {
          void this.notify.notifyAdmins(organizationId, 'outage', [
            [
              'Seit',
              new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
            ],
            ['Fehler', errorCode],
          ]);
        }
      }
    } catch (error) {
      this.logger.error(
        `Could not record TSE outage for unit ${tseUnitId}: ${(error as Error).message}`,
      );
    }
  }

  /** Nach einem erfolgreichen Vorgang: offenen Ausfall schliessen. */
  async recordSuccess(
    organizationId: string,
    tseUnitId: string,
  ): Promise<void> {
    this.openCache.set(tseUnitId, { open: false, at: Date.now() });
    if (this.maybeOpen.get(tseUnitId) === false) return;
    try {
      const closed = rowsOf<{ id: string }>(
        await this.outageRepository.query(
          `UPDATE tse_outages SET ended_at = now(), updated_at = now()
            WHERE tse_unit_id = $1 AND ended_at IS NULL RETURNING id`,
          [tseUnitId],
        ),
      );
      this.maybeOpen.set(tseUnitId, false);
      if (closed.length > 0) {
        this.logger.log(`TSE outage closed for org ${organizationId}`);
        this.notify.statusChanged(organizationId, {
          state: 'ok',
          outage: false,
        });
      }
    } catch (error) {
      this.logger.error(
        `Could not close TSE outage for unit ${tseUnitId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Ist fuer diese TSE gerade ein Ausfall offen? Nach einem Fehlschlag bzw.
   * Erfolg auf dieser Instanz sofort aktuell, sonst hoechstens
   * `OPEN_CACHE_MS` alt (Ausfaelle anderer Instanzen). Wirft nie.
   */
  async isOpen(tseUnitId: string): Promise<boolean> {
    const cached = this.openCache.get(tseUnitId);
    if (cached && Date.now() - cached.at < OPEN_CACHE_MS) return cached.open;
    try {
      const open = await this.outageRepository.exists({
        where: { tseUnitId, endedAt: IsNull() },
      });
      this.openCache.set(tseUnitId, { open, at: Date.now() });
      return open;
    } catch (error) {
      this.logger.warn(
        `Could not look up TSE outage for unit ${tseUnitId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Offener Ausfall der TSE (fuer Status-Antworten). */
  findOpen(tseUnitId: string): Promise<TseOutage | null> {
    return this.outageRepository.findOne({
      where: { tseUnitId, endedAt: IsNull() },
    });
  }

  list(organizationId: string, limit = 50): Promise<TseOutage[]> {
    return this.outageRepository.find({
      where: { organizationId },
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }
}
