import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { DataSource, In, IsNull, Not, type EntityManager } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  PinCredential,
  type PinOwnerType,
} from '../../database/entities/pin-credential.entity';
import { UserOrganization } from '../../database/entities/user-organization.entity';
import {
  generatePin,
  isTrivialPin,
  pepperFingerprint,
  pinLookup,
  resolvePepper,
  type PepperOrigin,
} from './pin-crypto';

export interface PinOwner {
  ownerType: PinOwnerType;
  /** `waiters.id` bzw. `user_organizations.id`. */
  ownerId: string;
}

/** Wie viele bcrypt-Vergleiche gleichzeitig (libuv-Threadpool: 4). */
const BCRYPT_CONCURRENCY = 4;

export function pinNotAvailable(): BadRequestException {
  // Einheitlich fuer „vergeben“ und „zu einfach“: verraet nicht, ob eine
  // PIN schon jemandem gehoert.
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.PIN_NOT_AVAILABLE,
    message:
      'Diese PIN ist nicht verfügbar. Wähle eine andere (keine einfachen Folgen wie 1234 oder 0000).',
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: string }).code === '23505' ||
      (error as { driverError?: { code?: string } }).driverError?.code ===
        '23505')
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Ein PIN-Raum je Organisation fuer Mitglieder und Bedienungen
 * (bedienungen-plan.md §4, Entscheidung 1).
 *
 * - Gespeichert wird nur HMAC-SHA256(PIN_PEPPER, "<orgId>:<pin>"); die
 *   Datenbank erzwingt die Eindeutigkeit, das Nachschlagen ist O(1).
 * - Mitglieds-PINs aus der Zeit davor liegen noch als bcrypt in
 *   `user_organizations.pin`. Sie lassen sich nicht umrechnen: bis zur
 *   naechsten Eingabe gilt ein Rueckfall (bcrypt ueber die wenigen
 *   Mitglieder mit alter PIN). Beim ersten Treffer wandert die PIN hierher
 *   und das alte Feld wird geleert. Den Rueckfall nach 90 Tagen entfernen.
 * - Die PIN steht nie im Log, in Fehlermeldungen oder bei Sentry.
 */
@Injectable()
export class PinCredentialsService implements OnModuleInit {
  private readonly logger = new Logger(PinCredentialsService.name);
  private readonly pepper: Buffer;
  readonly pepperId: string;
  readonly pepperOrigin: PepperOrigin;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    const { pepper, origin } = resolvePepper({
      pinPepper: config.get<string>('PIN_PEPPER') ?? process.env.PIN_PEPPER,
      fallbackSecret:
        config.get<string>('TWO_FACTOR_ENCRYPTION_KEY') ??
        process.env.TWO_FACTOR_ENCRYPTION_KEY,
    });
    this.pepper = pepper;
    this.pepperOrigin = origin;
    this.pepperId = pepperFingerprint(pepper);
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'production') return;
    if (this.pepperOrigin === 'derived') {
      this.logger.warn(
        'PIN_PEPPER is not set — PINs of members and servers are peppered with a key derived from TWO_FACTOR_ENCRYPTION_KEY. Set PIN_PEPPER (openssl rand -base64 32) before PINs are issued; changing it later invalidates all PINs.',
      );
    } else if (this.pepperOrigin === 'development') {
      this.logger.error(
        'Neither PIN_PEPPER nor TWO_FACTOR_ENCRYPTION_KEY is set — PINs use the public development pepper. Set PIN_PEPPER.',
      );
    }
  }

  lookupOf(organizationId: string, pin: string): string {
    return pinLookup(this.pepper, organizationId, pin);
  }

  private repo(manager?: EntityManager) {
    return (manager ?? this.dataSource.manager).getRepository(PinCredential);
  }

  /**
   * Wem gehoert diese PIN? Erst ueber den Pruefwert, dann (Rueckfall) ueber
   * alte bcrypt-Mitglieds-PINs. Ein Treffer im Rueckfall zieht die PIN in
   * den neuen Raum nach.
   */
  async resolve(organizationId: string, pin: string): Promise<PinOwner | null> {
    if (!/^\d{4,8}$/.test(pin)) return null;
    const credential = await this.repo().findOne({
      where: {
        organizationId,
        pinLookup: this.lookupOf(organizationId, pin),
        pepperId: this.pepperId,
      },
    });
    if (credential) {
      return { ownerType: credential.ownerType, ownerId: credential.ownerId };
    }
    const legacy = await this.legacyMatch(organizationId, pin);
    if (!legacy) return null;
    await this.migrateLegacy(organizationId, legacy, pin);
    return { ownerType: 'member', ownerId: legacy.id };
  }

  /** Mitglieder dieser Organisation mit alter bcrypt-PIN. */
  private legacyMembers(
    organizationId: string,
    manager?: EntityManager,
  ): Promise<Pick<UserOrganization, 'id' | 'pin'>[]> {
    return (manager ?? this.dataSource.manager)
      .getRepository(UserOrganization)
      .find({
        where: { organizationId, pin: Not(IsNull()) },
        select: { id: true, pin: true },
      });
  }

  private async legacyMatch(
    organizationId: string,
    pin: string,
    manager?: EntityManager,
    exceptMembershipId?: string,
  ): Promise<Pick<UserOrganization, 'id' | 'pin'> | null> {
    const members = (await this.legacyMembers(organizationId, manager)).filter(
      (m) => m.id !== exceptMembershipId,
    );
    if (!members.length) return null;
    const matches = await mapLimit(members, BCRYPT_CONCURRENCY, (m) =>
      m.pin ? bcrypt.compare(pin, m.pin) : Promise.resolve(false),
    );
    const index = matches.findIndex(Boolean);
    return index >= 0 ? members[index] : null;
  }

  private async migrateLegacy(
    organizationId: string,
    member: Pick<UserOrganization, 'id'>,
    pin: string,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager
          .createQueryBuilder()
          .insert()
          .into(PinCredential)
          .values({
            organizationId,
            ownerType: 'member',
            ownerId: member.id,
            pinLookup: this.lookupOf(organizationId, pin),
            pepperId: this.pepperId,
            pinLength: pin.length,
          })
          .orUpdate(
            ['pin_lookup', 'pepper_id', 'pin_length', 'updated_at'],
            ['owner_type', 'owner_id'],
          )
          .execute();
        await manager
          .getRepository(UserOrganization)
          .update({ id: member.id }, { pin: null });
      });
      this.logger.log(`Member PIN of membership ${member.id} migrated`);
    } catch (error) {
      // Kollidiert der Pruefwert (dieselbe PIN gehoert inzwischen einer
      // Bedienung), bleibt die alte PIN stehen; die Anmeldung gelingt
      // trotzdem ueber den Rueckfall.
      this.logger.warn(
        `Member PIN of membership ${member.id} not migrated: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Prueft, ob `pin` vergeben werden darf (nicht trivial, nicht vergeben,
   * auch nicht als alte Mitglieds-PIN). `owner` = wer sie bekommen soll
   * (die eigene PIN zaehlt nicht als vergeben).
   */
  async assertAvailable(
    organizationId: string,
    pin: string,
    owner?: PinOwner,
    manager?: EntityManager,
  ): Promise<void> {
    if (isTrivialPin(pin)) throw pinNotAvailable();
    const taken = await this.repo(manager).findOne({
      where: {
        organizationId,
        pinLookup: this.lookupOf(organizationId, pin),
        pepperId: this.pepperId,
      },
      select: { id: true, ownerType: true, ownerId: true },
    });
    if (
      taken &&
      !(
        owner &&
        taken.ownerType === owner.ownerType &&
        taken.ownerId === owner.ownerId
      )
    ) {
      throw pinNotAvailable();
    }
    const legacy = await this.legacyMatch(
      organizationId,
      pin,
      manager,
      owner?.ownerType === 'member' ? owner.ownerId : undefined,
    );
    if (legacy) throw pinNotAvailable();
  }

  /** Setzt (oder ersetzt) die PIN eines Inhabers. */
  async assign(
    organizationId: string,
    owner: PinOwner,
    pin: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.assertAvailable(organizationId, pin, owner, manager);
    await this.write(organizationId, owner, pin, manager);
  }

  private async write(
    organizationId: string,
    owner: PinOwner,
    pin: string,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      await (manager ?? this.dataSource.manager)
        .createQueryBuilder()
        .insert()
        .into(PinCredential)
        .values({
          organizationId,
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          pinLookup: this.lookupOf(organizationId, pin),
          pepperId: this.pepperId,
          pinLength: pin.length,
        })
        .orUpdate(
          ['pin_lookup', 'pepper_id', 'pin_length', 'updated_at'],
          ['owner_type', 'owner_id'],
        )
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) throw pinNotAvailable();
      throw error;
    }
  }

  /**
   * Erzeugt fuer jeden Inhaber eine neue, eindeutige PIN (CSPRNG, nie
   * trivial) und speichert sie. Gibt die PINs einmalig zurueck.
   */
  async generate(
    organizationId: string,
    owners: PinOwner[],
    length: 4 | 6,
    manager?: EntityManager,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!owners.length) return result;
    const legacy = await this.legacyMembers(organizationId, manager);
    const pending = [...owners];
    for (let round = 0; pending.length && round < 50; round += 1) {
      // Kandidaten ohne Doppel untereinander und ohne bereits vergebene.
      const used = new Set(result.values());
      const candidates = new Map<string, string>();
      for (const owner of pending) {
        let pin = generatePin(length);
        while (used.has(pin)) pin = generatePin(length);
        used.add(pin);
        candidates.set(owner.ownerId, pin);
      }
      const lookups = [...candidates.values()].map((pin) =>
        this.lookupOf(organizationId, pin),
      );
      const taken = new Set(
        (
          await this.repo(manager).find({
            where: { organizationId, pinLookup: In(lookups) },
            select: { pinLookup: true, ownerType: true, ownerId: true },
          })
        )
          .filter(
            (c) =>
              !pending.some(
                (o) => o.ownerType === c.ownerType && o.ownerId === c.ownerId,
              ),
          )
          .map((c) => c.pinLookup),
      );
      const legacyHits = legacy.length
        ? await mapLimit(
            [...candidates.entries()],
            BCRYPT_CONCURRENCY,
            async ([, pin]) => {
              for (const member of legacy) {
                if (member.pin && (await bcrypt.compare(pin, member.pin))) {
                  return true;
                }
              }
              return false;
            },
          )
        : [];
      const retry: PinOwner[] = [];
      let index = 0;
      for (const owner of pending) {
        const pin = candidates.get(owner.ownerId)!;
        const clash =
          taken.has(this.lookupOf(organizationId, pin)) || legacyHits[index];
        index += 1;
        if (clash) {
          retry.push(owner);
          continue;
        }
        try {
          await this.write(organizationId, owner, pin, manager);
          result.set(owner.ownerId, pin);
        } catch (error) {
          if (
            error instanceof BadRequestException &&
            (error.getResponse() as { reason?: string }).reason ===
              ErrorReasons.PIN_NOT_AVAILABLE
          ) {
            retry.push(owner);
          } else {
            throw error;
          }
        }
      }
      pending.splice(0, pending.length, ...retry);
    }
    if (pending.length) {
      // PIN-Raum fast voll (4 Ziffern, sehr viele Inhaber).
      throw pinNotAvailable();
    }
    return result;
  }

  async remove(owner: PinOwner, manager?: EntityManager): Promise<void> {
    await this.repo(manager).delete({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    });
  }

  /** Welche der Inhaber haben eine gueltige PIN (aktueller Pepper)? */
  async ownersWithPin(
    ownerType: PinOwnerType,
    ownerIds: string[],
  ): Promise<Set<string>> {
    if (!ownerIds.length) return new Set();
    const rows = await this.repo().find({
      where: { ownerType, ownerId: In(ownerIds), pepperId: this.pepperId },
      select: { ownerId: true },
    });
    return new Set(rows.map((r) => r.ownerId));
  }
}
