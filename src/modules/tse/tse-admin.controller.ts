import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { TseUnit } from '../../database/entities/tse-unit.entity';
import { QueryTseUsageDto } from './dto/tse.dto';
import { errorCodeOf } from './swissbit/swissbit.errors';
import { SwissbitClientProvider } from './swissbit/swissbit-client.provider';
import { TseConfig } from './tse.config';
import { localParts } from './tse-dates';
import { unitView } from './tse-status.service';

/**
 * Betreiber-Sicht (Super-Admins): alle TSEs mit Anlass und Laufzeit und
 * der Nutzungsbericht der Billing API (Grundlage fuer die Kosten).
 */
@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin/tse')
@UseGuards(SuperAdminGuard)
export class TseAdminController {
  constructor(
    @InjectRepository(TseUnit)
    private readonly unitRepository: Repository<TseUnit>,
    private readonly swissbit: SwissbitClientProvider,
    private readonly config: TseConfig,
  ) {}

  @Get('units')
  @ApiOperation({
    summary: 'All Cloud-TSE units (super admin)',
    description:
      'Alle TSEs aller Organisationen mit Zustand, Auslöser (`manual`, `auto`, `super_admin`), auslösender Veranstaltung, Anlage-/Aktiv-/Deaktivierungszeit und aktiven Monaten.',
  })
  async units() {
    const units = await this.unitRepository.find({
      relations: { organization: true },
      order: { createdAt: 'DESC' },
      take: 1000,
    });
    return {
      data: units.map((unit) => ({
        ...unitView(unit),
        publicKey: undefined,
        organization: unit.organization
          ? { id: unit.organization.id, name: unit.organization.name }
          : null,
        billedMonths: billedMonths(unit),
      })),
    };
  }

  @Get('usage')
  @ApiOperation({
    summary: 'Swissbit usage report for a month (super admin)',
    description:
      'Nutzungsbericht der Swissbit Billing API für den Credit Token der Plattform: angelegte, aktive (berechnete) und deaktivierte TSEs des Monats, je TSE mit Organisation.',
  })
  async usage(@Query() query: QueryTseUsageDto) {
    const now = localParts(new Date());
    const year = query.year ?? now.year;
    const month = query.month ?? now.month;
    if (!this.config.enabled || !this.swissbit.hasVendorCredentials) {
      return {
        data: { year, month, available: false, report: null, error: null },
      };
    }
    try {
      const report = (
        await this.swissbit.client.usageReport(
          this.config.settings.swissbit.creditClientId,
          year,
          month,
        )
      ).value;
      const serials = [
        ...report.createdTses,
        ...report.activeTses,
        ...report.deactivatedTses,
      ].map((t) => t.tseSerialNumber);
      const units = serials.length
        ? await this.unitRepository
            .createQueryBuilder('unit')
            .leftJoinAndSelect('unit.organization', 'org')
            .where('unit.serialNumber IN (:...serials)', { serials })
            .getMany()
        : [];
      const bySerial = new Map(units.map((u) => [u.serialNumber, u]));
      const annotate = <T extends { tseSerialNumber: string }>(item: T) => {
        const unit = bySerial.get(item.tseSerialNumber);
        return {
          ...item,
          organization: unit?.organization
            ? { id: unit.organization.id, name: unit.organization.name }
            : null,
          unitId: unit?.id ?? null,
        };
      };
      return {
        data: {
          year,
          month,
          available: true,
          report: {
            createdTses: report.createdTses.map(annotate),
            activeTses: report.activeTses.map(annotate),
            deactivatedTses: report.deactivatedTses.map(annotate),
          },
          error: null,
        },
      };
    } catch (error) {
      return {
        data: {
          year,
          month,
          available: true,
          report: null,
          error: errorCodeOf(error),
        },
      };
    }
  }
}

/**
 * Kalendermonate (Berlin), die Swissbit berechnet: vom Anlagemonat bis zum
 * Deaktivierungsmonat (keine Teilmonate).
 */
export function billedMonths(
  unit: Pick<TseUnit, 'createdAt' | 'deactivatedAt' | 'serialNumber'>,
  now = new Date(),
): string[] {
  if (!unit.serialNumber) return [];
  const start = localParts(unit.createdAt);
  const end = localParts(unit.deactivatedAt ?? now);
  const months: string[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (months.length > 240) break;
  }
  return months;
}
