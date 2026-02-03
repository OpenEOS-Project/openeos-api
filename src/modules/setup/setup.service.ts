import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import {
  User,
  Organization,
  UserOrganization,
  CreditPackage,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { SetupDto, SetupMode } from './dto';

const BCRYPT_ROUNDS = 12;
const UNLIMITED_CREDITS = 999999999;

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
    @InjectRepository(CreditPackage)
    private readonly creditPackageRepository: Repository<CreditPackage>,
    private readonly dataSource: DataSource,
  ) {}

  async isSetupRequired(): Promise<{ required: boolean; reason?: string }> {
    const userCount = await this.userRepository.count();

    if (userCount === 0) {
      return {
        required: true,
        reason: 'Keine Benutzer vorhanden. Erstmalige Einrichtung erforderlich.',
      };
    }

    return { required: false };
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

    // Validate organizationName for single mode
    if (setupDto.mode === SetupMode.SINGLE && !setupDto.organizationName) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Organisationsname ist bei Single-Modus erforderlich',
      });
    }

    if (setupDto.mode === SetupMode.SINGLE) {
      return this.performSingleTenantSetup(setupDto);
    } else {
      return this.performMultiTenantSetup(setupDto);
    }
  }

  private async performSingleTenantSetup(setupDto: SetupDto): Promise<SetupResult> {
    const { email, password, firstName, lastName, organizationName } = setupDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Create admin user (NOT super admin)
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = this.userRepository.create({
        email: email.toLowerCase(),
        passwordHash,
        firstName,
        lastName,
        isActive: true,
        isSuperAdmin: false,
        emailVerifiedAt: new Date(),
      });
      await queryRunner.manager.save(user);

      // 2. Create organization with unlimited credits
      const slug = await this.generateOrganizationSlug(organizationName!, queryRunner.manager);
      const supportPin = this.generateSupportPin();

      const organization = this.organizationRepository.create({
        name: organizationName!,
        slug,
        supportPin,
        settings: {},
        eventCredits: UNLIMITED_CREDITS,
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

      this.logger.log(`Single-Tenant Setup completed: Admin ${user.email} with organization ${organization.name}`);

      return {
        mode: SetupMode.SINGLE,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isSuperAdmin: false,
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

  private async performMultiTenantSetup(setupDto: SetupDto): Promise<SetupResult> {
    const { email, password, firstName, lastName } = setupDto;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Create credit packages
      await this.seedCreditPackages(queryRunner.manager);

      // 2. Create super admin user
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

      this.logger.log(`Multi-Tenant Setup completed: Super Admin ${user.email} created`);

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

  private async seedCreditPackages(manager: any): Promise<void> {
    const existingCount = await manager.count(CreditPackage);
    if (existingCount > 0) {
      this.logger.log('Credit packages already exist, skipping seed');
      return;
    }

    const packages = [
      {
        name: '1 Tag',
        slug: '1-tag',
        credits: 1,
        price: 25.0,
        pricePerCredit: 25.0,
        savingsPercent: 0,
        description: 'Für einzelne Veranstaltungstage',
        isActive: true,
        sortOrder: 1,
      },
      {
        name: '1 Wochenende',
        slug: '1-wochenende',
        credits: 2,
        price: 50.0,
        pricePerCredit: 25.0,
        savingsPercent: 0,
        description: 'Für Wochenendveranstaltungen (2 Tage)',
        isActive: true,
        isFeatured: true,
        sortOrder: 2,
      },
      {
        name: '1 Woche',
        slug: '1-woche',
        credits: 5,
        price: 125.0,
        pricePerCredit: 25.0,
        savingsPercent: 0,
        description: 'Für einwöchige Veranstaltungen (5 Tage)',
        isActive: true,
        sortOrder: 3,
      },
      {
        name: 'Monats-Abo',
        slug: 'monats-abo',
        credits: 30,
        price: 250.0,
        pricePerCredit: 8.33,
        savingsPercent: 67,
        description: 'Für Dauerbetriebe - unbegrenzte Nutzung für 30 Tage',
        isActive: true,
        sortOrder: 4,
      },
    ];

    for (const pkg of packages) {
      const creditPackage = this.creditPackageRepository.create(pkg);
      await manager.save(creditPackage);
    }

    this.logger.log(`Created ${packages.length} credit packages`);
  }

  private async generateOrganizationSlug(name: string, manager: any): Promise<string> {
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
