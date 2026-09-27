import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, Organization, UserOrganization } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { SetupDto, SetupMode } from './dto';
import { DeploymentService } from '../../common/services/deployment.service';
import type { DeploymentMode } from '../../config/configuration';

const BCRYPT_ROUNDS = 12;

export interface SetupStatus {
  required: boolean;
  reason?: string;
  /** Betriebsart dieser Installation — steuert, was die Oberflaeche zeigt. */
  deployment: {
    mode: DeploymentMode;
    billingEnabled: boolean;
    multiTenant: boolean;
  };
}

export interface SetupResult {
  mode: SetupMode;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    isSuperAdmin: boolean;
  };
  organization?: {
    id: string;
    name: string;
    slug: string;
  };
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    private readonly dataSource: DataSource,
    private readonly deployment: DeploymentService,
  ) {}

  async isSetupRequired(): Promise<SetupStatus> {
    /* Die Betriebsart haengt mit an dieser Antwort, weil sie die erste
       Anfrage der Oberflaeche ueberhaupt ist — ein eigener Endpunkt waere ein
       zweiter Rundlauf, bevor irgendetwas angezeigt werden kann. */
    const deployment = {
      mode: this.deployment.mode,
      billingEnabled: this.deployment.billingEnabled,
      multiTenant: this.deployment.multiTenant,
    };

    const userCount = await this.userRepository.count();

    if (userCount === 0) {
      return {
        required: true,
        reason:
          'Keine Benutzer vorhanden. Erstmalige Einrichtung erforderlich.',
        deployment,
      };
    }

    return { required: false, deployment };
  }

  async performSetup(setupDto: SetupDto): Promise<SetupResult> {
    // Check if setup is still required
    const setupStatus = await this.isSetupRequired();
    if (!setupStatus.required) {
      throw new ConflictException({
        code: 'SETUP_ALREADY_COMPLETE',
        message: 'Die Einrichtung wurde bereits durchgeführt',
      });
    }

    /* Eine eigenstaendige Installation kennt nur den Einzelbetrieb. Die Wahl
       im Assistenten zu belassen hiesse, jemandem einen Multi-Mandanten-
       Aufbau anzubieten, den der Rest der Installation anschliessend
       verweigert — die Betriebsart steht in der Umgebung fest, nicht im
       Formular. */
    const mode = this.deployment.isSelfHosted
      ? SetupMode.SINGLE
      : setupDto.mode;

    // Validate organizationName for single mode
    if (mode === SetupMode.SINGLE && !setupDto.organizationName) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Organisationsname ist bei Single-Modus erforderlich',
      });
    }

    if (mode === SetupMode.SINGLE) {
      return this.performSingleTenantSetup(setupDto);
    } else {
      return this.performMultiTenantSetup(setupDto);
    }
  }

  private async performSingleTenantSetup(
    setupDto: SetupDto,
  ): Promise<SetupResult> {
    const { email, password, firstName, lastName, organizationName } = setupDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      /* 1. Admin anlegen.

         Im gehosteten Betrieb ist das bewusst KEIN Super-Admin: dort gibt es
         eine Betreiberrolle ueber den Mandanten, und ein Kunde gehoert nicht
         hinein.

         Eigenstaendig gibt es diese Trennung nicht — es gibt niemanden
         "darueber". Ohne Super-Admin-Recht kaeme man an Geraeteverwaltung,
         Druckerzuordnung, Benutzerentsperrung und Protokoll gar nicht heran:
         die haengen alle am SuperAdminGuard. Die rein kommerziellen
         Endpunkte dahinter sind per @SaasOnly() ohnehin abgeschaltet. */
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = this.userRepository.create({
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        isActive: true,
        isSuperAdmin: this.deployment.isSelfHosted,
        emailVerifiedAt: new Date(),
      });
      await queryRunner.manager.save(user);

      // 2. Organisation anlegen
      const slug = await this.generateOrganizationSlug(
        organizationName!,
        queryRunner.manager,
      );
      const supportPin = this.generateSupportPin();

      const organization = this.organizationRepository.create({
        name: organizationName!,
        slug,
        supportPin,
        settings: {},
      });
      await queryRunner.manager.save(organization);

      // 3. Link user to organization as admin
      const userOrganization = this.userOrganizationRepository.create({
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      });
      await queryRunner.manager.save(userOrganization);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Single-Tenant Setup completed: Admin ${user.email} with organization ${organization.name}`,
      );

      return {
        mode: SetupMode.SINGLE,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isSuperAdmin: user.isSuperAdmin,
        },
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
        },
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async performMultiTenantSetup(
    setupDto: SetupDto,
  ): Promise<SetupResult> {
    const { email, password, firstName, lastName } = setupDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Create super admin user
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = this.userRepository.create({
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        isActive: true,
        isSuperAdmin: true,
        emailVerifiedAt: new Date(),
      });
      await queryRunner.manager.save(user);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Multi-Tenant Setup completed: Super Admin ${user.email} created`,
      );

      return {
        mode: SetupMode.MULTI,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isSuperAdmin: true,
        },
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async generateOrganizationSlug(
    name: string,
    manager: any,
  ): Promise<string> {
    const baseSlug = name
      .toLowerCase()
      .replace(/[äöü]/g, (match) => {
        const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue' };
        return map[match];
      })
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    let slug = baseSlug;
    let counter = 1;

    while (await manager.findOne(Organization, { where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private generateSupportPin(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}
