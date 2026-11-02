import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Organization, User } from '../../../database/entities';
import {
  AdminAction,
  AdminAuditLog,
} from '../../../database/entities/admin-audit-log.entity';
import { OrganizationCashPolicyChange } from '../../../database/entities/organization-cash-policy-change.entity';
import { OrganizationRole } from '../../../database/entities/user-organization.entity';
import {
  ErrorCodes,
  ErrorReasons,
} from '../../../common/constants/error-codes';
import { normalizeCountry } from '../../../common/constants/countries';
import { GatewayService } from '../../gateway/gateway.service';
import { OrganizationsService } from '../organizations.service';
import {
  recordCountryChange,
  writeCountry,
  type ClientInfo,
} from './country.writes';

export type CountryHistoryItem = Pick<
  OrganizationCashPolicyChange,
  | 'id'
  | 'createdAt'
  | 'fromValue'
  | 'toValue'
  | 'reason'
  | 'bySupport'
  | 'changedByName'
>;

function invalidCountry(): BadRequestException {
  return new BadRequestException({
    code: ErrorCodes.VALIDATION_ERROR,
    reason: ErrorReasons.COUNTRY_INVALID,
    message: 'Bitte wähle ein Land aus der Liste.',
  });
}

/**
 * Land einer Organisation (`organizations.country`), Grundlage fuer die
 * waehlbaren Betriebsarten (operating-mode.util.ts).
 *
 * - Neue Organisationen bringen das Land beim Anlegen mit.
 * - Bestandsorganisationen ohne Land setzen es genau einmal selbst.
 * - Danach aendert es nur der Support, mit Grund (Admin-Protokoll).
 */
@Injectable()
export class CountryService {
  private readonly logger = new Logger(CountryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly organizationsService: OrganizationsService,
    private readonly gatewayService: GatewayService,
  ) {}

  private async lockCountry(
    manager: EntityManager,
    organizationId: string,
  ): Promise<string | null> {
    const [row] = await manager.query<{ country: string | null }[]>(
      `SELECT country FROM organizations
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [organizationId],
    );
    if (!row) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return row.country;
  }

  /** Verlauf des Landes, neueste zuerst. Ohne Pruefung des Zugriffs. */
  history(organizationId: string): Promise<CountryHistoryItem[]> {
    return this.dataSource.getRepository(OrganizationCashPolicyChange).find({
      where: { organizationId, kind: 'country' },
      select: {
        id: true,
        createdAt: true,
        fromValue: true,
        toValue: true,
        reason: true,
        bySupport: true,
        changedByName: true,
      },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /**
   * Land einmalig setzen (Admins der Organisation). Steht schon eins, 403
   * COUNTRY_ALREADY_SET — aendern kann es dann nur der Support.
   */
  async setCountryOnce(
    organizationId: string,
    country: string,
    user: User,
    client: ClientInfo = {},
  ): Promise<{ country: string }> {
    const code = normalizeCountry(country);
    if (!code) throw invalidCountry();
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockCountry(manager, organization.id);
      if (current) {
        throw new ForbiddenException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.COUNTRY_ALREADY_SET,
          message:
            'Das Land deiner Organisation ist schon festgelegt. Ändern kann es nur der OpenEOS-Support.',
          params: { country: current },
        });
      }
      await writeCountry(manager, organization.id, code);
      await recordCountryChange(manager, {
        organizationId: organization.id,
        fromValue: null,
        toValue: code,
        user,
        client,
      });
    });
    this.logger.log(
      `Country of organization ${organization.id} set to ${code} by user ${user.id}`,
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(organization.id);
    return { country: code };
  }

  /** Land aendern (nur Support, mit Grund, im Admin-Protokoll). */
  async adminSetCountry(
    organizationId: string,
    country: string,
    reason: string,
    admin: User,
    client: ClientInfo = {},
  ): Promise<{ country: string }> {
    const code = normalizeCountry(country);
    if (!code) throw invalidCountry();
    const trimmed = reason.trim();
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lockCountry(manager, organizationId);
      if (current === code) {
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          reason: ErrorReasons.COUNTRY_UNCHANGED,
          message: 'Die Organisation hat dieses Land schon.',
          params: { country: code },
        });
      }
      await writeCountry(manager, organizationId, code);
      await recordCountryChange(manager, {
        organizationId,
        fromValue: current,
        toValue: code,
        reason: trimmed,
        bySupport: true,
        user: admin,
        client,
      });
      await manager.insert(AdminAuditLog, {
        adminUserId: admin.id,
        organizationId,
        action: AdminAction.SET_ORGANIZATION_COUNTRY,
        resourceType: 'organization',
        resourceId: organizationId,
        details: {
          before: { country: current ?? undefined },
          after: { country: code },
        },
        reason: trimmed,
        ipAddress: (client.ipAddress || '0.0.0.0').slice(0, 45),
        userAgent: client.userAgent?.slice(0, 500) ?? null,
      });
    });
    this.logger.log(
      `Country of organization ${organizationId} changed to ${code} by super admin ${admin.id}`,
    );
    this.gatewayService.notifyOrganizationSettingsUpdated(organizationId);
    return { country: code };
  }
}

/**
 * Anschrift fuer die Bescheinigung: `settings.address` (mit Strasse), sonst
 * die Kontaktadresse aus den Einstellungen, sonst die Rechnungsadresse.
 */
export function certificateAddress(organization: Organization): {
  street?: string;
  zip?: string;
  city?: string;
  country?: string;
} | null {
  const address = organization.settings?.address;
  if (address?.street?.trim()) return address;
  const contact = organization.settings?.contact as
    | { address?: string; zipCode?: string; city?: string }
    | undefined;
  if (contact?.address?.trim() || contact?.city?.trim()) {
    return {
      street: contact.address,
      zip: contact.zipCode,
      city: contact.city,
      country: organization.country ?? undefined,
    };
  }
  return organization.billingAddress ?? null;
}
