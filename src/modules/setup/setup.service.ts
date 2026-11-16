import { initialOperatingMode } from '../../common/utils/operating-mode.util';
import { randomInt } from 'crypto';
import {
  Injectable,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, Organization, UserOrganization } from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { SetupDto, SetupMode } from './dto';
import { DeploymentService } from '../../common/services/deployment.service';
import { OrganizationLimitsService } from '../../common/services/organization-limits.service';
import type { DeploymentMode } from '../../config/configuration';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { generateSetupToken, setupTokenMatches } from './setup-token';

/** Schluessel in platform_settings. */
const SETUP_TOKEN_KEY = 'setup.token';
const SETUP_COMPLETED_KEY = 'setup.completedAt';
/** Hält parallele Einrichtungen (mehrere Instanzen) auseinander. */
const SETUP_LOCK = 7_301_202_611;

const BCRYPT_ROUNDS = 12;

export interface SetupStatus {
  required: boolean;
  reason?: string;
  /**
   * Die Einrichtung verlangt den Einrichtungscode (`X-Setup-Token`): aus
   * `SETUP_TOKEN` oder beim Start ins Protokoll der API geschrieben.
   */
  tokenRequired?: boolean;
  /** Betriebsart dieser Installation — steuert, was die Oberflaeche zeigt. */
  deployment: {
    mode: DeploymentMode;
    billingEnabled: boolean;
    multiTenant: boolean;
    /** Standard-Schranken dieser Installation (0 = unbegrenzt). */
    limits: {
      organizationsPerUser: number;
      membersPerOrganization: number;
      waitersPerOrganization: number;
    };
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
export class SetupService implements OnApplicationBootstrap {
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
    private readonly limits: OrganizationLimitsService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Beim Start: Ist die Einrichtung noch offen, steht der Einrichtungscode
   * im Protokoll — wer die API betreibt, sieht ihn; wer nur die Adresse
   * kennt, nicht. Bestehende Installationen bekommen die Markierung
   * „eingerichtet“, damit die Einrichtung nie wieder aufgeht.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      if (!(await this.isOpen())) return;
      const fromEnv = this.envToken();
      if (fromEnv) {
        this.logger.warn(
          'Ersteinrichtung offen: Einrichtungscode aus SETUP_TOKEN verwenden.',
        );
        return;
      }
      const token = await this.storedToken();
      this.logger.warn(
        `Ersteinrichtung offen. Einrichtungscode: ${token} (gilt bis zur Einrichtung)`,
      );
    } catch (error) {
      this.logger.warn(
        `Einrichtungsstatus beim Start nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private envToken(): string | null {
    const value = this.config?.get<string>('SETUP_TOKEN')?.trim();
    return value ? value : null;
  }

  /** Gemeinsamer Code aller Instanzen, einmal erzeugt. */
  private async storedToken(): Promise<string> {
    await this.dataSource.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [SETUP_TOKEN_KEY, JSON.stringify({ value: generateSetupToken() })],
    );
    const rows: { value: { value?: string } }[] = await this.dataSource.query(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [SETUP_TOKEN_KEY],
    );
    const token = rows[0]?.value?.value;
    if (!token) throw new Error('Einrichtungscode fehlt');
    return token;
  }

  /**
   * Offen nur, solange es keine Benutzer gibt und die Einrichtung nie
   * abgeschlossen wurde. Gibt es Benutzer, wird die Markierung nachgetragen.
   */
  private async isOpen(manager?: EntityManager): Promise<boolean> {
    const db = manager ?? this.dataSource.manager;
    const done: unknown[] = await db.query(
      `SELECT 1 FROM platform_settings WHERE key = $1`,
      [SETUP_COMPLETED_KEY],
    );
    if (done.length > 0) return false;
    const [{ count }]: { count: string }[] = await db.query(
      `SELECT count(*)::text AS count FROM users`,
    );
    if (Number(count) === 0) return true;
    await this.markCompleted(db);
    return false;
  }

  private async markCompleted(manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        SETUP_COMPLETED_KEY,
        JSON.stringify({ value: new Date().toISOString() }),
      ],
    );
    await manager.query(`DELETE FROM platform_settings WHERE key = $1`, [
      SETUP_TOKEN_KEY,
    ]);
  }

  private async assertSetupToken(given: string | null | undefined) {
    const expected = this.envToken() ?? (await this.storedToken());
    if (!setupTokenMatches(given, expected)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.SETUP_TOKEN_INVALID,
        message:
          'Der Einrichtungscode stimmt nicht. Du findest ihn im Protokoll der API oder in SETUP_TOKEN.',
      });
    }
  }

  /**
   * In der Transaktion der Einrichtung: sperren und erneut pruefen, damit
   * von zwei gleichzeitigen Einrichtungen nur eine durchkommt; danach als
   * abgeschlossen markieren.
   */
  private async claimSetup(manager: EntityManager): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock($1)`, [SETUP_LOCK]);
    if (!(await this.isOpen(manager))) {
      throw new ConflictException({
        code: 'SETUP_ALREADY_COMPLETE',
        message: 'Die Einrichtung wurde bereits durchgeführt',
      });
    }
    await this.markCompleted(manager);
  }

  async isSetupRequired(): Promise<SetupStatus> {
    /* Die Betriebsart haengt mit an dieser Antwort, weil sie die erste
       Anfrage der Oberflaeche ueberhaupt ist — ein eigener Endpunkt waere ein
       zweiter Rundlauf, bevor irgendetwas angezeigt werden kann. */
    const deployment = {
      mode: this.deployment.mode,
      billingEnabled: this.deployment.billingEnabled,
      multiTenant: this.deployment.multiTenant,
      // Damit die Oberflaeche "leer = Standard (5/10)" mit den echten
      // Werten dieser Installation beschriften kann.
      limits: {
        organizationsPerUser: this.limits.defaultOrganizationLimit,
        membersPerOrganization: this.limits.defaultMemberLimit,
        waitersPerOrganization: this.limits.defaultWaiterLimit,
      },
    };

    if (await this.isOpen()) {
      return {
        required: true,
        reason:
          'Keine Benutzer vorhanden. Erstmalige Einrichtung erforderlich.',
        tokenRequired: true,
        deployment,
      };
    }

    return { required: false, deployment };
  }

  async performSetup(
    setupDto: SetupDto,
    setupToken?: string | null,
  ): Promise<SetupResult> {
    // Check if setup is still required
    if (!(await this.isOpen())) {
      throw new ConflictException({
        code: 'SETUP_ALREADY_COMPLETE',
        message: 'Die Einrichtung wurde bereits durchgeführt',
      });
    }
    await this.assertSetupToken(setupToken);

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
        reason: ErrorReasons.ORGANIZATION_NAME_REQUIRED,
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
      await this.claimSetup(queryRunner.manager);

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
        // Eigene Installation: `full` mit Bestand (der Verein betreibt den
        // Server selbst). Im gehosteten Betrieb fragt die Oberflaeche das
        // Land danach einmal ab.
        ...initialOperatingMode(null, this.deployment.isSelfHosted),
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
      await this.claimSetup(queryRunner.manager);

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
    manager: EntityManager,
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
    // Sechsstellig wie bisher (100000–999999), aber aus crypto statt Math.random.
    return randomInt(100000, 1000000).toString();
  }
}
