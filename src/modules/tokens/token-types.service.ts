import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { OPERATING_MODE_SELECT } from '../../common/utils/operating-mode.util';
import { Category } from '../../database/entities/category.entity';
import { Event } from '../../database/entities/event.entity';
import { Organization } from '../../database/entities/organization.entity';
import { Product } from '../../database/entities/product.entity';
import { TokenType } from '../../database/entities/token-type.entity';
import type { User } from '../../database/entities/user.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { CreateTokenTypeDto, UpdateTokenTypeDto } from './dto';
import { isTokensAllowed, singlePurposeProblem } from './token-rules';

/** Markentyp mit dem Hinweis, ob er schon gebucht wurde. */
export type TokenTypeView = TokenType & { inUse?: boolean };

/**
 * Markentypen der Organisation (Verwaltung: Recht „Produkte“). Pruefung
 * des Einzweckgutscheins nach dem Steuerberater (Frage 13): nur, wenn alle
 * zugeordneten Artikel denselben Satz haben. Ist ein Typ schon verkauft
 * oder eingeloest, bleiben Nennwert, Art, Satz und Artikelauswahl fest —
 * ausgegebene Marken behalten ihren Wert und ihre steuerliche Behandlung.
 */
@Injectable()
export class TokenTypesService {
  private readonly logger = new Logger(TokenTypesService.name);

  constructor(
    @InjectRepository(TokenType)
    private readonly tokenTypeRepository: Repository<TokenType>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepository: Repository<UserOrganization>,
  ) {}

  private get manager() {
    return this.tokenTypeRepository.manager;
  }

  async findAll(
    organizationId: string,
    user: User,
    eventId?: string,
  ): Promise<TokenTypeView[]> {
    await this.checkMembership(organizationId, user.id);
    const types = await this.tokenTypeRepository.find({
      where: eventId
        ? [
            { organizationId, eventId },
            { organizationId, eventId: IsNull() },
          ]
        : { organizationId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    const used = await this.usedTypeIds(
      organizationId,
      types.map((t) => t.id),
    );
    return types.map((t) => Object.assign(t, { inUse: used.has(t.id) }));
  }

  /**
   * Aktive Markentypen fuer die Kasse (Veranstaltung + organisationsweit).
   * Leer, wo Wertmarken nicht erlaubt sind („Bargeldlos“, „Nur Bons“, DE
   * ohne TSE) — die Kasse blendet sie dann aus.
   */
  async findForDevice(
    organizationId: string,
    eventId: string | null,
  ): Promise<TokenType[]> {
    const organization = await this.manager.findOne(Organization, {
      where: { id: organizationId },
      select: OPERATING_MODE_SELECT,
    });
    if (!isTokensAllowed(organization)) return [];
    return this.tokenTypeRepository.find({
      where: eventId
        ? [
            { organizationId, isActive: true, eventId },
            { organizationId, isActive: true, eventId: IsNull() },
          ]
        : { organizationId, isActive: true, eventId: IsNull() },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async create(
    organizationId: string,
    dto: CreateTokenTypeDto,
    user: User,
  ): Promise<TokenType> {
    await this.checkPermission(organizationId, user.id);
    const values = await this.validated(organizationId, {
      name: dto.name.trim(),
      value: dto.value,
      kind: dto.kind ?? 'multi_purpose',
      vatRate: dto.vatRate ?? null,
      eventId: dto.eventId ?? null,
      allowedCategoryIds: dto.allowedCategoryIds ?? [],
      allowedProductIds: dto.allowedProductIds ?? [],
    });
    const type = this.tokenTypeRepository.create({
      organizationId,
      ...values,
      color: dto.color ?? null,
      buybackAllowed: dto.buybackAllowed === true,
      isActive: dto.isActive ?? true,
      sortOrder: dto.sortOrder ?? 0,
    });
    await this.tokenTypeRepository.save(type);
    this.logger.log(`Token type created: ${type.name} (${type.id})`);
    return Object.assign(type, { inUse: false });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateTokenTypeDto,
    user: User,
  ): Promise<TokenType> {
    await this.checkPermission(organizationId, user.id);
    const type = await this.findOwned(organizationId, id);
    const inUse = (await this.usedTypeIds(organizationId, [id])).has(id);
    const next = {
      name: dto.name !== undefined ? dto.name.trim() : type.name,
      value: dto.value !== undefined ? dto.value : Number(type.value),
      kind: dto.kind ?? type.kind,
      vatRate:
        dto.vatRate !== undefined
          ? dto.vatRate
          : type.vatRate === null
            ? null
            : Number(type.vatRate),
      eventId: dto.eventId !== undefined ? dto.eventId : type.eventId,
      allowedCategoryIds: dto.allowedCategoryIds ?? type.allowedCategoryIds,
      allowedProductIds: dto.allowedProductIds ?? type.allowedProductIds,
    };
    if (inUse) {
      const sameSet = (a: string[], b: string[]) =>
        a.length === b.length && a.every((x) => b.includes(x));
      const changed =
        Math.round(next.value * 100) !== Math.round(Number(type.value) * 100) ||
        next.kind !== type.kind ||
        (next.kind === 'single_purpose' &&
          (Math.round(Number(next.vatRate) * 100) !==
            Math.round(Number(type.vatRate) * 100) ||
            !sameSet(next.allowedCategoryIds, type.allowedCategoryIds) ||
            !sameSet(next.allowedProductIds, type.allowedProductIds) ||
            next.eventId !== type.eventId));
      if (changed) {
        throw new ConflictException({
          code: ErrorCodes.CONFLICT,
          reason: ErrorReasons.TOKEN_TYPE_LOCKED,
          message:
            'Von dieser Marke sind schon welche im Umlauf. Nennwert, Art und Steuersatz bleiben deshalb fest – lege für neue Marken einen neuen Typ an.',
        });
      }
    }
    const values = await this.validated(organizationId, next);
    Object.assign(type, values);
    if (dto.color !== undefined) type.color = dto.color;
    if (dto.buybackAllowed !== undefined)
      type.buybackAllowed = dto.buybackAllowed;
    if (dto.isActive !== undefined) type.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) type.sortOrder = dto.sortOrder;
    await this.tokenTypeRepository.save(type);
    return Object.assign(type, { inUse });
  }

  async remove(organizationId: string, id: string, user: User): Promise<void> {
    await this.checkPermission(organizationId, user.id);
    const type = await this.findOwned(organizationId, id);
    if ((await this.usedTypeIds(organizationId, [id])).has(id)) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.TOKEN_TYPE_IN_USE,
        message:
          'Diese Marke wurde schon verkauft oder angenommen. Deaktiviere sie statt sie zu löschen – Verkauf und Einlösung bleiben so nachvollziehbar.',
      });
    }
    await this.tokenTypeRepository.remove(type);
  }

  /** Typen, die schon verkauft, eingeloest oder zurueckgetauscht wurden. */
  async usedTypeIds(
    organizationId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.manager.query<{ id: string }[]>(
      `SELECT DISTINCT l->>'tokenTypeId' AS id
         FROM token_transactions t, jsonb_array_elements(t.lines) l
        WHERE t.organization_id = $1 AND l->>'tokenTypeId' = ANY($2::text[])
       UNION
       SELECT DISTINCT l->>'tokenTypeId' AS id
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         , jsonb_array_elements(p.token_lines) l
        WHERE o.organization_id = $1 AND l->>'tokenTypeId' = ANY($2::text[])`,
      [organizationId, ids],
    );
    return new Set(rows.map((r) => r.id));
  }

  private async findOwned(
    organizationId: string,
    id: string,
  ): Promise<TokenType> {
    const type = await this.tokenTypeRepository.findOne({
      where: { id, organizationId },
    });
    if (!type) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.TOKEN_TYPE_NOT_FOUND,
        message: 'Markentyp nicht gefunden',
      });
    }
    return type;
  }

  /**
   * Prueft Veranstaltung, Artikelauswahl und Einzweckgutschein; liefert die
   * zu speichernden Werte (Mehrzweck ohne Satz).
   */
  private async validated(
    organizationId: string,
    input: {
      name: string;
      value: number;
      kind: TokenType['kind'];
      vatRate: number | null;
      eventId: string | null;
      allowedCategoryIds: string[];
      allowedProductIds: string[];
    },
  ): Promise<{
    name: string;
    value: number;
    kind: TokenType['kind'];
    vatRate: number | null;
    eventId: string | null;
    allowedCategoryIds: string[];
    allowedProductIds: string[];
  }> {
    const categories = [...new Set(input.allowedCategoryIds)];
    const products = [...new Set(input.allowedProductIds)];
    if (input.eventId) {
      const event = await this.manager.findOne(Event, {
        where: { id: input.eventId, organizationId },
        select: { id: true },
      });
      if (!event) {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          reason: ErrorReasons.EVENT_NOT_FOUND,
          message: 'Veranstaltung nicht gefunden',
        });
      }
    }
    const restricted = categories.length > 0 || products.length > 0;
    if (restricted && !input.eventId) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TOKEN_RESTRICTION_REQUIRES_EVENT,
        message:
          'Kategorien und Artikel gehören zu einer Veranstaltung. Wähle die Veranstaltung, für die die Marke gilt – oder lass die Auswahl leer.',
      });
    }
    let restrictedRates: number[] | null = null;
    const restrictionEventId = input.eventId;
    if (restricted && restrictionEventId) {
      const foundCategories = categories.length
        ? await this.manager.find(Category, {
            where: { id: In(categories), eventId: restrictionEventId },
            select: { id: true },
          })
        : [];
      const foundProducts = await this.manager.find(Product, {
        where: [
          ...(categories.length
            ? [{ categoryId: In(categories), eventId: restrictionEventId }]
            : []),
          ...(products.length
            ? [{ id: In(products), eventId: restrictionEventId }]
            : []),
        ],
        select: { id: true, taxRate: true, isActive: true },
      });
      const direct = new Set(foundProducts.map((p) => p.id));
      const missingProducts = products.filter((id) => !direct.has(id));
      if (
        foundCategories.length !== categories.length ||
        missingProducts.length > 0
      ) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.TOKEN_LINES_INVALID,
          message:
            'Mindestens eine Kategorie oder ein Artikel gehört nicht zu dieser Veranstaltung.',
        });
      }
      restrictedRates = foundProducts.map((p) => Number(p.taxRate));
    }
    if (input.kind === 'single_purpose') {
      const organization = await this.manager.findOne(Organization, {
        where: { id: organizationId },
        select: { id: true, settings: true },
      });
      const problem = singlePurposeProblem({
        vatRate: input.vatRate,
        vatExempt: organization?.settings?.vatExempt,
        restrictedRates,
      });
      if (problem) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: problem.reason,
          message: problem.message,
          ...(problem.params ? { params: problem.params } : {}),
        });
      }
    }
    return {
      name: input.name,
      value: Math.round(Number(input.value) * 100) / 100,
      kind: input.kind,
      vatRate: input.kind === 'single_purpose' ? Number(input.vatRate) : null,
      eventId: input.eventId,
      allowedCategoryIds: categories,
      allowedProductIds: products,
    };
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.membershipRepository.findOne({
      where: { organizationId, userId },
    });
    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    return membership;
  }

  private async checkPermission(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.checkMembership(organizationId, userId);
    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.products
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
