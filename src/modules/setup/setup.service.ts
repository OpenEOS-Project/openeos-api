import {
  Injectable,
  ConflictException,
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
import { SetupDto } from './dto';

const BCRYPT_ROUNDS = 12;

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

  async performSetup(setupDto: SetupDto): Promise<{
    user: User;
    organization: Organization;
  }> {
    // Check if setup is still required
    const setupStatus = await this.isSetupRequired();
    if (!setupStatus.required) {
      throw new ConflictException({
        code: 'SETUP_ALREADY_COMPLETE',
        message: 'Die Einrichtung wurde bereits durchgeführt',
      });
    }

    const { email, password, firstName, lastName, organizationName } = setupDto;

    // Use transaction for atomic setup
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Create credit packages if they don't exist
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
      });
      await queryRunner.manager.save(user);

      // 3. Create first organization
      const slug = await this.generateOrganizationSlug(organizationName, queryRunner.manager);
      const supportPin = this.generateSupportPin();

      const organization = this.organizationRepository.create({
        name: organizationName,
        slug,
        supportPin,
        settings: {},
      });
      await queryRunner.manager.save(organization);

      // 4. Link user to organization as admin
      const userOrganization = this.userOrganizationRepository.create({
        user,
        organization,
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      });
      await queryRunner.manager.save(userOrganization);

      await queryRunner.commitTransaction();

      this.logger.log(`Setup completed: Super Admin ${user.email} created with organization ${organization.name}`);

      return { user, organization };
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
        name: 'Starter',
        credits: 50,
        price: 29.0,
        description: 'Ideal für kleine Veranstaltungen',
        isActive: true,
      },
      {
        name: 'Standard',
        credits: 150,
        price: 79.0,
        description: 'Für mittlere Veranstaltungen',
        isActive: true,
      },
      {
        name: 'Premium',
        credits: 400,
        price: 199.0,
        description: 'Für große Veranstaltungen',
        isActive: true,
      },
      {
        name: 'Enterprise',
        credits: 1000,
        price: 449.0,
        description: 'Für Großveranstaltungen und Festivals',
        isActive: true,
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
