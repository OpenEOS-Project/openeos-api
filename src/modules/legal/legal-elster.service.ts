import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';

import { appVersion } from '../../common/constants/app-version';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import {
  Organization,
  OrganizationRole,
  type User,
} from '../../database/entities';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { taxMasterData } from '../dsfinvk/dsfinvk-master';
import { OrganizationsService } from '../organizations/organizations.service';
import { operatorFromEnv } from '../organizations/operating-mode/operating-mode-certificate';
import { clientIdForOrganization } from '../tse/tse-process-data';

export const SOFTWARE_NAME = 'OpenEOS';
export const REGISTER_KIND =
  'Computergestütztes Kassensystem (Cloud-Kasse im Browser bzw. in der App)';
export const TSE_KIND = 'Cloud-TSE';

export interface ElsterTseEntry {
  serialNumber: string | null;
  certificationId: string | null;
  certificateExpiresAt: string | null;
  productType: string;
  clientId: string;
  state: TseUnit['state'];
  activatedAt: string | null;
  deactivatedAt: string | null;
  kind: string;
}

export interface ElsterData {
  software: { name: string; manufacturer: string; version: string };
  register: { serialNumber: string; kind: string };
  location: {
    name: string;
    street: string;
    zip: string;
    city: string;
    complete: boolean;
  };
  taxNumber: string | null;
  vatId: string | null;
  /** Braucht die Organisation eine TSE (DE, „Alle Funktionen“) oder hat sie eine? */
  tseRequired: boolean;
  tse: ElsterTseEntry[];
}

const iso = (value: Date | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** Software und Kassen-Seriennummer — gleich fuer Seite und Buchungsmail. */
export function softwareFacts(
  get: (key: string) => string | undefined,
  organizationId: string,
) {
  return {
    software: {
      name: SOFTWARE_NAME,
      manufacturer: operatorFromEnv(get).name,
      version: appVersion(),
    },
    register: {
      serialNumber: clientIdForOrganization(organizationId),
      kind: REGISTER_KIND,
    },
  };
}

/**
 * Angaben fuer die Mitteilung nach § 146a Abs. 4 AO („Mein ELSTER“):
 * Software, Version, Seriennummer der Kasse (Client-ID `OEOS-…`), die
 * Betriebsstaette aus den Organisationsangaben und je TSE Seriennummer,
 * Zertifizierungs-ID, Zertifikat, Inbetriebnahme und Ausserbetriebnahme
 * (AGB Ziffern 4.6, 6.3 a, 15.7). Abgeloeste TSEs bleiben im Verlauf.
 */
@Injectable()
export class LegalElsterService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizations: Repository<Organization>,
    @InjectRepository(TseUnit)
    private readonly tseUnits: Repository<TseUnit>,
    private readonly organizationsService: OrganizationsService,
    private readonly configService: ConfigService,
  ) {}

  async elster(organizationId: string, user: User): Promise<ElsterData> {
    await this.organizationsService.checkRole(
      organizationId,
      user,
      OrganizationRole.ADMIN,
    );
    const organization = await this.organizations.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    const units = await this.tseUnits.find({
      where: { organizationId, state: Not('failed') },
      order: { createdAt: 'ASC' },
    });
    const master = taxMasterData(organization);
    const facts = softwareFacts(
      (key) => this.configService.get<string>(key),
      organizationId,
    );
    return {
      ...facts,
      location: {
        name: master.legalName,
        street: master.street,
        zip: master.zip,
        city: master.city,
        complete: !!(master.street && master.zip && master.city),
      },
      taxNumber: master.taxNumber || null,
      vatId: master.vatId || null,
      tseRequired:
        units.length > 0 ||
        ((organization.country ?? '').toUpperCase() === 'DE' &&
          organization.operatingMode === 'full'),
      tse: units.map((unit) => ({
        serialNumber: unit.serialNumber,
        certificationId: unit.certificationId,
        certificateExpiresAt: iso(unit.certificateExpiresAt),
        productType: unit.productType,
        clientId: unit.clientId,
        state: unit.state,
        activatedAt: iso(unit.activatedAt),
        deactivatedAt: iso(unit.deactivatedAt),
        kind: TSE_KIND,
      })),
    };
  }
}
