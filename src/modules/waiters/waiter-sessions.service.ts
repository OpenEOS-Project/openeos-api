import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { Device } from '../../database/entities/device.entity';
import { Event, EventStatus } from '../../database/entities/event.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import { Waiter } from '../../database/entities/waiter.entity';
import {
  WaiterSession,
  type WaiterSessionEndReason,
} from '../../database/entities/waiter-session.entity';
import {
  PinCredentialsService,
  type PinOwner,
} from './pin-credentials.service';
import { PinLockoutService } from './pin-lockout.service';
import { hashSessionToken, newSessionToken } from './pin-crypto';
import {
  memberOperator,
  operatorView,
  waiterModeOf,
  waiterOperator,
  type Operator,
} from './waiter-operator';

/** Ohne automatische Sperre endet eine Sitzung nach 12 h ohne Buchung. */
export const DEFAULT_IDLE_SECONDS = 12 * 3600;
/** Puffer auf die automatische Sperre des Geraets (Client-Uhr, Netz). */
export const IDLE_GRACE_SECONDS = 60;
/** last_seen_at hoechstens alle 30 s schreiben. */
const TOUCH_INTERVAL_MS = 30_000;

export type DeviceRef = Pick<
  Device,
  'id' | 'organizationId' | 'name' | 'settings'
>;

export interface WaiterSessionView {
  token?: string;
  sessionId: string;
  expiresAt: string;
  kind: 'waiter' | 'member';
  waiter: ReturnType<typeof operatorView>;
}

export function sessionRequiredError(): ForbiddenException {
  // 403 statt 401: aeltere Kassen loeschen bei 401 ihre Geraetekopplung.
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.WAITER_SESSION_REQUIRED,
    message: 'Bitte melde dich an der Kasse mit deiner PIN an.',
  });
}

export function sessionExpiredError(): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.WAITER_SESSION_EXPIRED,
    message:
      'Deine Anmeldung an der Kasse ist abgelaufen. Gib deine PIN erneut ein.',
  });
}

export function notPermittedError(permission: string): ForbiddenException {
  return new ForbiddenException({
    code: ErrorCodes.FORBIDDEN,
    reason: ErrorReasons.WAITER_NOT_PERMITTED,
    message:
      'Das darfst du nicht selbst. Eine Schichtleitung oder ein Admin gibt es mit ihrer PIN frei.',
    params: { permission },
  });
}

function idleSeconds(device: DeviceRef): number {
  const autoLock = Number(device.settings?.autoLockSeconds ?? 0);
  return autoLock > 0 ? autoLock + IDLE_GRACE_SECONDS : DEFAULT_IDLE_SECONDS;
}

/**
 * Bedienungs-Sitzungen an Geraeten (bedienungen-plan.md §5, §11).
 *
 * - Anmeldung per PIN (Bedienung oder Mitglied), Token 32 Byte Zufall,
 *   gespeichert nur als SHA-256, gebunden an das Geraet.
 * - Eine offene Sitzung je Geraet: die naechste Anmeldung beendet die
 *   vorige (Wechsel).
 * - Ende bei Sperre, Wechsel, Inaktivitaet (`autoLockSeconds` + 60 s,
 *   sonst 12 h), Geraet gesperrt, Bedienung deaktiviert, neue PIN, Ende
 *   der Veranstaltung (veranstaltungsgebundene Bedienung).
 */
@Injectable()
export class WaiterSessionsService {
  private readonly logger = new Logger(WaiterSessionsService.name);
  /** Mindestlaufzeit einer PIN-Pruefung (gleiche Antwortzeit, Treffer oder nicht). */
  minResponseMs = 250;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pins: PinCredentialsService,
    private readonly lockout: PinLockoutService,
  ) {}

  // ------------------------------------------------------------ Anmelden

  /**
   * PIN pruefen und Sitzung anlegen. 403 PIN_INVALID (mit
   * `remainingAttempts`), 429 PIN_LOCKED/PIN_DEVICE_LOCKED, 403
   * WAITER_NOT_FOR_EVENT.
   */
  async login(device: DeviceRef, pin: string): Promise<WaiterSessionView> {
    const organizationId = this.orgOf(device);
    const started = Date.now();
    try {
      await this.lockout.assertNotLocked(device);
      const operator = await this.identify(device, pin);
      await this.lockout.recordSuccess(device);
      return await this.dataSource.transaction(async (manager) => {
        await this.endOpen(manager, { deviceId: device.id }, 'switch');
        const event = await this.currentEvent(manager, organizationId);
        const { token, hash } = newSessionToken();
        const session = await manager.getRepository(WaiterSession).save(
          manager.getRepository(WaiterSession).create({
            organizationId,
            deviceId: device.id,
            eventId: event?.id ?? null,
            waiterId: operator.waiterId,
            userId: operator.waiterId ? null : operator.userId,
            tokenHash: hash,
          }),
        );
        if (operator.waiterId) {
          await manager
            .getRepository(Waiter)
            .update({ id: operator.waiterId }, { lastUsedAt: new Date() });
        }
        this.logger.log(
          `Waiter session ${session.id} started on device ${device.id} (${operator.kind})`,
        );
        return {
          token,
          sessionId: session.id,
          expiresAt: this.expiresAt(device, new Date()).toISOString(),
          kind: operator.kind,
          waiter: operatorView({ ...operator, sessionId: session.id }),
        };
      });
    } finally {
      await this.padResponse(started);
    }
  }

  /**
   * PIN einer Freigabe (Storno/Erstattung, Kassenlade) pruefen: liefert die
   * Person mit ihren Rechten. Fehlversuche zaehlen wie bei der Anmeldung.
   */
  async verifyApprover(device: DeviceRef, pin: string): Promise<Operator> {
    const started = Date.now();
    try {
      await this.lockout.assertNotLocked(device);
      const operator = await this.identify(device, pin);
      await this.lockout.recordSuccess(device);
      return operator;
    } finally {
      await this.padResponse(started);
    }
  }

  /** Person zur PIN (ohne Sitzung). Fehlversuch → 403 PIN_INVALID. */
  private async identify(device: DeviceRef, pin: string): Promise<Operator> {
    const organizationId = this.orgOf(device);
    const owner = await this.pins.resolve(organizationId, pin);
    const operator = owner
      ? await this.operatorFor(
          this.dataSource.manager,
          organizationId,
          owner,
          null,
        )
      : null;
    if (!operator) {
      const outcome = await this.lockout.recordFailure(device);
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.PIN_INVALID,
        message: 'Ungültige PIN',
        params: { remainingAttempts: outcome.remainingAttempts },
      });
    }
    if (operator.waiterId) {
      await this.assertWaiterUsable(this.dataSource.manager, operator.waiterId);
    }
    return operator;
  }

  private async operatorFor(
    manager: EntityManager,
    organizationId: string,
    owner: PinOwner,
    sessionId: string | null,
  ): Promise<Operator | null> {
    if (owner.ownerType === 'waiter') {
      const waiter = await manager.getRepository(Waiter).findOne({
        where: { id: owner.ownerId, organizationId, isActive: true },
      });
      if (!waiter || waiter.anonymizedAt) return null;
      return waiterOperator(waiter, sessionId);
    }
    const member = await manager.getRepository(UserOrganization).findOne({
      where: { id: owner.ownerId, organizationId },
      relations: ['user'],
    });
    if (!member?.user) return null;
    return memberOperator(member, member.user, sessionId);
  }

  /** Veranstaltungsgebundene Bedienung: nur solange die Veranstaltung laeuft. */
  private async assertWaiterUsable(
    manager: EntityManager,
    waiterId: string,
  ): Promise<void> {
    const rows: { event_id: string | null; status: string | null }[] =
      await manager.query(
        `SELECT w.event_id, e.status FROM waiters w
           LEFT JOIN events e ON e.id = w.event_id
          WHERE w.id = $1`,
        [waiterId],
      );
    const row = rows[0];
    if (!row?.event_id) return;
    if (row.status === EventStatus.ACTIVE || row.status === EventStatus.TEST) {
      return;
    }
    throw new ForbiddenException({
      code: ErrorCodes.FORBIDDEN,
      reason: ErrorReasons.WAITER_NOT_FOR_EVENT,
      message:
        'Diese Bedienung gehört zu einer Veranstaltung, die gerade nicht läuft.',
    });
  }

  // ------------------------------------------------------------ Anfragen

  /**
   * Wer bucht diese Anfrage? Je nach Geraetemodus:
   * - `personal`: die feste Bedienung (ohne Token).
   * - `shared`: Sitzung Pflicht (403 WAITER_SESSION_REQUIRED/EXPIRED).
   * - `off`: ohne Pflicht; ein gueltiges Token ordnet trotzdem zu.
   */
  async operatorForRequest(
    device: DeviceRef,
    token: string | undefined,
  ): Promise<Operator | null> {
    const mode = waiterModeOf(device.settings);
    if (mode === 'personal') return this.personalOperator(device);
    if (!token) {
      if (mode === 'shared') throw sessionRequiredError();
      return null;
    }
    const operator = await this.resolveToken(device, token);
    if (!operator && mode === 'shared') throw sessionExpiredError();
    return operator;
  }

  /** Aktuelle Sitzung (GET nach Neuladen); null, wenn keine gueltig ist. */
  async current(
    device: DeviceRef,
    token: string | undefined,
  ): Promise<Omit<WaiterSessionView, 'token'> | null> {
    const mode = waiterModeOf(device.settings);
    if (mode === 'personal') {
      const operator = await this.personalOperator(device).catch(() => null);
      return operator
        ? {
            sessionId: '',
            expiresAt: '',
            kind: operator.kind,
            waiter: operatorView(operator),
          }
        : null;
    }
    if (!token) return null;
    const operator = await this.resolveToken(device, token);
    if (!operator) return null;
    return {
      sessionId: operator.sessionId ?? '',
      expiresAt: this.expiresAt(device, new Date()).toISOString(),
      kind: operator.kind,
      waiter: operatorView(operator),
    };
  }

  async personalOperator(device: DeviceRef): Promise<Operator> {
    const organizationId = this.orgOf(device);
    const waiterId = device.settings?.waiterId;
    const waiter =
      typeof waiterId === 'string'
        ? await this.dataSource.getRepository(Waiter).findOne({
            where: { id: waiterId, organizationId, isActive: true },
          })
        : null;
    if (!waiter || waiter.anonymizedAt) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.WAITER_DEVICE_UNASSIGNED,
        message:
          'Gerät ist keiner Bedienung zugeordnet. Ein Admin wählt die feste Bedienung in der Verwaltung unter Geräte.',
      });
    }
    await this.assertWaiterUsable(this.dataSource.manager, waiter.id);
    return waiterOperator(waiter, null);
  }

  private async resolveToken(
    device: DeviceRef,
    token: string,
  ): Promise<Operator | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
      return null;
    }
    const organizationId = this.orgOf(device);
    const repo = this.dataSource.getRepository(WaiterSession);
    const session = await repo.findOne({
      where: { tokenHash: hashSessionToken(token) },
    });
    // Token eines anderen Geraets (oder einer anderen Organisation) gilt nicht.
    if (
      !session ||
      session.endedAt ||
      session.deviceId !== device.id ||
      session.organizationId !== organizationId
    ) {
      return null;
    }
    const now = Date.now();
    const idleMs = idleSeconds(device) * 1000;
    if (now - new Date(session.lastSeenAt).getTime() > idleMs) {
      await this.endOpen(
        this.dataSource.manager,
        { id: session.id },
        'timeout',
      );
      return null;
    }
    const owner: PinOwner | null = session.waiterId
      ? { ownerType: 'waiter', ownerId: session.waiterId }
      : null;
    let operator: Operator | null = null;
    if (owner) {
      operator = await this.operatorFor(
        this.dataSource.manager,
        organizationId,
        owner,
        session.id,
      );
      if (operator) {
        try {
          await this.assertWaiterUsable(this.dataSource.manager, owner.ownerId);
        } catch {
          operator = null;
        }
      }
    } else if (session.userId) {
      const member = await this.dataSource
        .getRepository(UserOrganization)
        .findOne({
          where: { userId: session.userId, organizationId },
          relations: ['user'],
        });
      operator = member?.user
        ? memberOperator(member, member.user, session.id)
        : null;
    }
    if (!operator) {
      await this.endOpen(
        this.dataSource.manager,
        { id: session.id },
        'revoked',
      );
      return null;
    }
    if (now - new Date(session.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
      await repo.update({ id: session.id }, { lastSeenAt: new Date(now) });
    }
    return operator;
  }

  // ------------------------------------------------------------ Beenden

  async end(
    device: DeviceRef,
    token: string | undefined,
    reason: WaiterSessionEndReason,
  ): Promise<boolean> {
    if (!token) return false;
    const result = await this.dataSource.getRepository(WaiterSession).update(
      {
        tokenHash: hashSessionToken(token),
        deviceId: device.id,
        endedAt: IsNull(),
      },
      { endedAt: new Date(), endReason: reason },
    );
    return (result.affected ?? 0) > 0;
  }

  /** Alle offenen Sitzungen einer Bedienung (deaktiviert, neue PIN). */
  async endForWaiter(
    waiterId: string,
    reason: WaiterSessionEndReason,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    return this.endOpen(manager, { waiterId }, reason);
  }

  async endForMember(
    organizationId: string,
    userId: string,
    reason: WaiterSessionEndReason,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    return this.endOpen(manager, { organizationId, userId }, reason);
  }

  async endForDevice(
    deviceId: string,
    reason: WaiterSessionEndReason,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    return this.endOpen(manager, { deviceId }, reason);
  }

  private async endOpen(
    manager: EntityManager,
    where: {
      id?: string;
      deviceId?: string;
      waiterId?: string;
      userId?: string;
      organizationId?: string;
    },
    reason: WaiterSessionEndReason,
  ): Promise<number> {
    const result = await manager
      .getRepository(WaiterSession)
      .update(
        { ...where, endedAt: IsNull() },
        { endedAt: new Date(), endReason: reason },
      );
    return result.affected ?? 0;
  }

  // ------------------------------------------------------------ Hilfen

  private orgOf(device: DeviceRef): string {
    if (!device.organizationId) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.DEVICE_NOT_ASSIGNED,
        message: 'Gerät ist keiner Organisation zugeordnet',
      });
    }
    return device.organizationId;
  }

  private async currentEvent(
    manager: EntityManager,
    organizationId: string,
  ): Promise<Event | null> {
    const events = await manager.getRepository(Event).find({
      where: {
        organizationId,
        status: In([EventStatus.ACTIVE, EventStatus.TEST]),
      },
      order: { status: 'ASC' },
      take: 1,
      select: { id: true, status: true },
    });
    return events[0] ?? null;
  }

  private expiresAt(device: DeviceRef, from: Date): Date {
    return new Date(from.getTime() + idleSeconds(device) * 1000);
  }

  private async padResponse(started: number): Promise<void> {
    const wait = this.minResponseMs - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Darf die Bedienung das selbst? Ohne Bedienung (Modus `off`) gilt die
 * Kasse wie bisher; mit Bedienung entscheidet ihre Rolle bzw. ihr Schalter.
 */
export function assertOperatorMay(
  operator: Operator | null | undefined,
  permission: keyof Operator['permissions'],
): void {
  if (!operator) return;
  if (!operator.permissions[permission]) throw notPermittedError(permission);
}
