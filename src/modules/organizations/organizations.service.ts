import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  Organization,
  User,
  UserOrganization,
  Invitation,
} from '../../database/entities';
import {
  OrganizationRole,
  OrganizationPermissions,
} from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { assertCanGrant, assertCanManage } from './member-access.util';
import {
  PaginationDto,
  PaginatedResult,
  createPaginatedResult,
} from '../../common/dto/pagination.dto';
import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
  AddMemberDto,
  UpdateMemberDto,
  CreateInvitationDto,
} from './dto';
import { EmailService } from '../email/email.service';
import { normalizeLegalSettings } from './legal/legal-settings.util';
import { normalizeWaiterSettings } from '../waiters/waiter-settings';
import { normalizeEventReminderSettings } from '../event-notifications/event-notification-settings';
import {
  initialOperatingMode,
  keepCountryMirror,
  stripModeSettings,
} from '../../common/utils/operating-mode.util';
import { recordInitialCountry } from './country/country.writes';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { ConfigService } from '@nestjs/config';
import { TseConfig, tseNotAvailableMessage } from '../tse/tse.config';
import {
  AdminAction,
  AdminAuditLog,
} from '../../database/entities/admin-audit-log.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { OrganizationLimitsService } from '../../common/services/organization-limits.service';
import { restoreMaskedCredentials } from '../../common/utils/response-redaction.util';
import { isKnownIntegration } from '../integrations/integration-catalog';
import { recordDeletion } from '../retention/deletion-log';
import { restoreOrganization } from '../retention/organization-restore';
import { memberView, type MemberView } from './member-view';

const INVITATION_EXPIRY_DAYS = 7;
const BCRYPT_ROUNDS = 12;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    private readonly dataSource: DataSource,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
    private readonly configService: ConfigService,
    private readonly deployment: DeploymentService,
    private readonly limits: OrganizationLimitsService,
  ) {}

  async create(
    createDto: CreateOrganizationDto,
    user: User,
  ): Promise<Organization> {
    await this.assertAdditionalOrganizationAllowed();

    const slug = await this.generateSlug(createDto.name);
    const supportPin = this.generateSupportPin();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Sperrt die Benutzerzeile bis zum Commit — zwei gleichzeitige
      // Anfragen koennen so nicht beide die letzte freie Organisation anlegen.
      await this.limits.assertCanJoinOrganization(user, queryRunner.manager);

      const organization = this.organizationRepository.create({
        name: createDto.name,
        slug,
        supportPin,
        settings: stripModeSettings(createDto.settings) || {},
        country: createDto.country,
        ...initialOperatingMode(
          createDto.country,
          this.deployment.isSelfHosted,
        ),
      });
      await queryRunner.manager.save(organization);
      await recordInitialCountry(
        queryRunner.manager,
        organization.id,
        createDto.country,
        user,
      );

      // Add creator as admin
      const userOrganization = this.userOrganizationRepository.create({
        user,
        organization,
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
        permissions: {},
      });
      await queryRunner.manager.save(userOrganization);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Organization created: ${organization.name} (${organization.id})`,
      );

      // Outside the transaction so a slow/failed email provider never rolls
      // back the organization creation.
      await this.notifyAdminOfOrganizationCreated(organization, user);

      return organization;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Legt beim Hinzufuegen eines Mitglieds das fehlende Konto gleich mit an.
   *
   * Nur eigenstaendig: im gehosteten Betrieb bleibt es bei "Benutzer nicht
   * gefunden", dort fuehrt der Weg ueber Einladung oder Registrierung.
   *
   * Das Konto gilt sofort als bestaetigt. Das ist kein uebergangener
   * Sicherheitsschritt: die Bestaetigungsmail beweist, dass der Anmeldende
   * das Postfach besitzt — hier legt jemand mit Mitgliederrecht das Konto
   * bewusst fuer eine bekannte Person an. Ohne das waere das neue Konto
   * genau so ausgesperrt wie zuvor.
   */
  private async createMemberAccount(addMemberDto: AddMemberDto): Promise<User> {
    const { email, firstName, lastName, password } = addMemberDto;

    if (!this.deployment.isSelfHosted) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.USER_NOT_FOUND,
        message: 'Benutzer nicht gefunden',
      });
    }

    if (!password || !firstName || !lastName) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.MEMBER_ACCOUNT_DETAILS_REQUIRED,
        message:
          'Zu dieser E-Mail-Adresse gibt es noch kein Konto. ' +
          'Bitte Vorname, Nachname und ein Startpasswort angeben, um es anzulegen.',
      });
    }

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

    await this.userRepository.save(user);
    this.logger.log(
      `Benutzerkonto ueber Mitgliederverwaltung angelegt: ${user.email}`,
    );

    return user;
  }

  /**
   * Eine eigenstaendige Installation verwaltet genau eine Organisation.
   *
   * Die Pruefung sitzt im Service und nicht als `@SaasOnly()` am Endpunkt:
   * das Anlegen der ersten Organisation muss moeglich bleiben, falls die
   * Ersteinrichtung im Multi-Modus lief oder die Organisation geloescht
   * wurde. Verboten ist nur die zweite.
   */
  private async assertAdditionalOrganizationAllowed(): Promise<void> {
    if (this.deployment.multiTenant) return;

    const bestehende = await this.organizationRepository.count();
    if (bestehende > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.SINGLE_ORGANIZATION_LIMIT,
        message:
          'Diese Installation verwaltet genau eine Organisation. ' +
          'Für weitere Organisationen wird der Mehrmandanten-Betrieb benötigt.',
      });
    }
  }

  /**
   * Sends the "new organization" notice to the configured admin notification
   * address. Silently does nothing if the toggle is off or no address is
   * configured anywhere.
   */
  private async notifyAdminOfOrganizationCreated(
    organization: Organization,
    creator: User,
  ): Promise<void> {
    const notifyEmail =
      await this.platformSettingsService.resolveNotificationTarget(
        'organizationCreated',
      );
    if (!notifyEmail) {
      return;
    }

    await this.emailService.sendAdminOrganizationCreatedNotification({
      to: notifyEmail,
      organizationName: organization.name,
      creatorEmail: creator.email,
      createdAt: new Date(),
    });
  }

  async findAll(
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<Organization>> {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    // Get organizations where user is a member
    const query = this.organizationRepository
      .createQueryBuilder('org')
      .innerJoin('org.userOrganizations', 'uo', 'uo.userId = :userId', {
        userId: user.id,
      })
      // Geloeschte Organisationen bleiben bis zur endgueltigen Loeschung fuer
      // ihre Administratoren sichtbar (nur lesend, AGB 10.4).
      .withDeleted()
      .where(
        `(org.deletedAt IS NULL OR (uo.role = 'admin'
           AND org.slug NOT LIKE 'purged-%'
           AND NOT EXISTS (SELECT 1 FROM retention_notices n
                            WHERE n.subject_type = 'organization'
                              AND n.subject_id = org.id
                              AND n.kind = 'organization_deletion'
                              AND n.executed_at IS NOT NULL)))`,
      )
      .orderBy('org.name', 'ASC')
      .skip(skip)
      .take(limit);

    const [items, total] = await query.getManyAndCount();

    return createPaginatedResult(items, total, page, limit);
  }

  async findOne(id: string, user: User): Promise<Organization> {
    // Auch geloeschte: bis zur endgueltigen Loeschung lesen deren
    // Administratoren sie noch (Schreibzugriffe sperrt der
    // OrganizationClosureGuard).
    const organization = await this.organizationRepository.findOne({
      where: { id },
      relations: ['userOrganizations', 'userOrganizations.user'],
      withDeleted: true,
    });

    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.ORGANIZATION_NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }

    // Check if user is a member
    await this.checkMembership(organization.id, user);

    return organization;
  }

  /**
   * Belegte und verfuegbare Plaetze fuer die Mitgliederseite. `memberLimit`
   * ist die wirksame Schranke (eigener Wert oder Standard, 0 = unbegrenzt),
   * nicht der rohe Spaltenwert — die Oberflaeche soll nicht wissen muessen,
   * was der Standard ist. Bewusst nicht am Entity selbst gesetzt: findOne()
   * dient auch den Schreibpfaden, und ein ueberschriebener Spaltenwert
   * wuerde beim naechsten save() in der Datenbank landen.
   */
  async memberUsage(organization: Organization) {
    return this.limits.memberUsage(organization);
  }

  /**
   * Steuerstatus (Kleinunternehmer ↔ umsatzsteuerpflichtig) mit Cloud-TSE
   * nur ueber `POST /organizations/:id/vat-status`: dort wird vorher ein
   * Kassenabschluss erstellt, damit alle bisherigen Vorgaenge mit dem alten
   * Status abgeschlossen sind (DSFinV-K Tz. 3). Ohne TSE-Vorgaenge (keine
   * DSFinV-K) bleibt der einfache Schalter.
   */
  private async assertVatStatusChangeAllowed(
    organization: Organization,
    incoming: object | null | undefined,
  ): Promise<void> {
    if (!incoming || !('vatExempt' in incoming)) return;
    const next = (incoming as { vatExempt?: unknown }).vatExempt !== false;
    const current = organization.settings?.vatExempt !== false;
    if (next === current) return;
    const rows: unknown[] = await this.organizationRepository.manager.query(
      `SELECT 1 FROM tse_transactions WHERE organization_id = $1 LIMIT 1`,
      [organization.id],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.VAT_STATUS_CHANGE_REQUIRES_CLOSING,
        message:
          'Mit Cloud-TSE wechselst du den Steuerstatus über „Steuerstatus ändern“: OpenEOS erstellt vorher einen Kassenabschluss.',
      });
    }
  }

  async update(
    id: string,
    updateDto: UpdateOrganizationDto,
    user: User,
  ): Promise<Organization> {
    const organization = await this.findOne(id, user);

    // Check if user is admin
    await this.checkRole(organization.id, user, OrganizationRole.ADMIN);

    /* Maskierte Zugangsdaten zurueckuebersetzen. Die Oberflaeche bekommt
       Schluessel nur als `****1234` zu sehen (siehe
       response-redaction.util.ts) und schickt genau das beim Speichern
       zurueck. Ohne diesen Schritt stuende danach `****1234` als Schluessel
       in der Datenbank. `organization` ist hier das unmaskierte Entity —
       findOne() maskiert nicht mehr selbst. */
    restoreMaskedCredentials(
      updateDto.settings,
      organization.settings as unknown as Record<string, unknown>,
    );

    /* Einstellungen zusammenfuehren statt ersetzen. Object.assign ist flach:
       ein Aufrufer, der nur `settings: { vatExempt: true }` schickt, haette
       sonst Waehrung, Zeitzone, Pfand-Regeln und SumUp-Zugangsdaten mit
       geloescht. Bisher ging das nur gut, weil jeder Abschnitt der
       Oberflaeche die vollstaendigen Einstellungen mitschickte — was
       ausserdem bedeutet, dass zwei gleichzeitig geoeffnete Reiter einander
       ueberschreiben. Zusammengefuehrt wird eine Ebene tief; wer `pos`
       schickt, ersetzt `pos` als Ganzes, und das ist auch gemeint. */
    const { settings: incomingSettings, ...rest } = updateDto;
    await this.assertVatStatusChangeAllowed(organization, incomingSettings);
    /* Nur Felder uebernehmen, die wirklich mitgeschickt wurden. Das DTO
       kommt als Klasseninstanz an (ES2023-Klassenfelder): nicht gesendete
       Felder stehen darin als eigene Schluessel mit `undefined`. Ein
       blindes Object.assign setzte damit `name` & Co. am Entity auf
       undefined — save() laesst die Spalten zwar in Ruhe, die Antwort kam
       aber ohne Namen zurueck. `null` bleibt erlaubt (Feld leeren). */
    Object.assign(
      organization,
      Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      ),
    );
    /* Die rechtlichen Angaben erscheinen auf oeffentlichen Seiten (Shop,
       Helferseiten) — deshalb hier streng pruefen und bereinigen statt sie
       wie den Rest der Einstellungen ungesehen abzulegen. */
    if (incomingSettings && 'legal' in incomingSettings) {
      incomingSettings.legal = normalizeLegalSettings(incomingSettings.legal);
    }
    if (incomingSettings && 'eventReminders' in incomingSettings) {
      incomingSettings.eventReminders = {
        ...normalizeEventReminderSettings(
          organization.settings?.eventReminders,
        ),
        ...normalizeEventReminderSettings(incomingSettings.eventReminders),
      };
    }
    if (incomingSettings && 'waiters' in incomingSettings) {
      incomingSettings.waiters = normalizeWaiterSettings(
        incomingSettings.waiters,
      );
    }
    // Die Betriebsart steht in eigenen Spalten und wechselt nur ueber
    // PATCH :id/operating-mode (Verlauf, Protokoll, TSE-Pruefung). Felder
    // der frueheren Zwischenloesungen bleiben hier aussen vor.
    stripModeSettings(incomingSettings);
    // Das Land kommt aus organizations.country; settings.address.country
    // ist nur dessen Kopie und laesst sich hier nicht aendern.
    keepCountryMirror(incomingSettings, organization.country);
    if (incomingSettings) {
      organization.settings = {
        ...organization.settings,
        ...incomingSettings,
      } as typeof organization.settings;
    }
    await this.organizationRepository.save(organization);

    this.logger.log(
      `Organization updated: ${organization.name} (${organization.id})`,
    );

    return organization;
  }

  /**
   * Schaltet eine Integration fuer die Organisation ein oder aus.
   *
   * Geschrieben wird gezielt nur `settings.integrations.<id>`, per
   * jsonb-Zusammenfuehrung in der Datenbank. Der Weg ueber update() und
   * save() kaeme hier nicht in Frage: er schreibt die kompletten
   * Einstellungen zurueck, und sobald irgendwo ein maskiertes Objekt
   * (`****1234`) dazwischengeraet, stuende die Maske als SumUp-Schluessel
   * in der Datenbank. Zugangsdaten bleiben so beim Umschalten unberuehrt —
   * auch beim Ausschalten, damit Wiedereinschalten ohne Neueingabe geht.
   */
  async setIntegrationEnabled(
    id: string,
    integrationId: string,
    enabled: boolean,
    user: User,
    meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<Organization> {
    const organization = await this.findOne(id, user);
    await this.checkRole(organization.id, user, OrganizationRole.ADMIN);

    if (!isKnownIntegration(integrationId)) {
      throw new NotFoundException({
        code: ErrorCodes.INTEGRATION_NOT_FOUND,
        message: 'Integration nicht gefunden',
      });
    }
    if (integrationId === 'tse') {
      await this.assertTseIntegrationChange(organization, enabled);
    }

    const entry = enabled
      ? { enabled: true, enabledAt: new Date().toISOString() }
      : { enabled: false };

    await this.organizationRepository.query(
      `UPDATE organizations
          SET settings = jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{integrations}',
                CASE WHEN jsonb_typeof(settings->'integrations') = 'object'
                     THEN settings->'integrations'
                     ELSE '{}'::jsonb
                END || jsonb_build_object($2::text, $3::jsonb),
                true
              ),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [organization.id, integrationId, JSON.stringify(entry)],
    );

    this.logger.log(
      `Integration ${integrationId} ${enabled ? 'enabled' : 'disabled'} for organization ${organization.id}`,
    );
    if (integrationId === 'tse') {
      // Einschalten heisst „der Verein will eine Cloud-TSE“ (Kosten ab
      // Anlage) — deshalb im Protokoll wie die Assistent-Funktionen.
      await this.dataSource
        .getRepository(AdminAuditLog)
        .save(
          this.dataSource.getRepository(AdminAuditLog).create({
            adminUserId: user.id,
            organizationId: organization.id,
            action: enabled
              ? AdminAction.TSE_INTEGRATION_ENABLED
              : AdminAction.TSE_INTEGRATION_DISABLED,
            resourceType: 'organization',
            resourceId: organization.id,
            details: { integration: 'tse', enabled },
            ipAddress: (meta.ipAddress || '0.0.0.0').slice(0, 45),
            userAgent: meta.userAgent?.slice(0, 500) ?? null,
          }),
        )
        .catch((error: Error) =>
          this.logger.error(
            `Audit for tse integration not written: ${error.message}`,
          ),
        );
    }

    return this.findOne(organization.id, user);
  }

  /**
   * Cloud-TSE als Integration: nur in Deutschland und nur, wenn der Server
   * eine TSE anbieten kann. Ausschalten mit laufender TSE geht nicht — die
   * Deaktivierung ist endgueltig und braucht ihren eigenen, ausdruecklich
   * bestaetigten Schritt (POST /organizations/:id/tse/deactivate).
   */
  private async assertTseIntegrationChange(
    organization: Organization,
    enabled: boolean,
  ): Promise<void> {
    if (enabled) {
      if ((organization.country ?? '').toUpperCase() !== 'DE') {
        throw new BadRequestException({
          code: ErrorCodes.TSE_COUNTRY_NOT_SUPPORTED,
          message:
            'Die Cloud-TSE gibt es nur für Organisationen in Deutschland',
        });
      }
      const tse = new TseConfig(this.configService);
      if (!tse.enabled) {
        throw new ServiceUnavailableException({
          code: ErrorCodes.TSE_NOT_AVAILABLE,
          message: tseNotAvailableMessage(tse.availability),
        });
      }
      return;
    }
    const live: unknown = await this.dataSource.query(
      `SELECT 1 FROM tse_units
        WHERE organization_id = $1 AND state IN ('creating', 'active') LIMIT 1`,
      [organization.id],
    );
    if (Array.isArray(live) && live.length > 0) {
      throw new ConflictException({
        code: ErrorCodes.TSE_ACTIVE_DEACTIVATE_FIRST,
        message:
          'Die Cloud-TSE ist noch aktiv. Deaktiviere sie zuerst ausdrücklich (endgültig), dann kannst du die Integration ausschalten.',
      });
    }
  }

  async remove(id: string, user: User): Promise<void> {
    const organization = await this.findOne(id, user);

    // Check if user is admin
    await this.checkRole(organization.id, user, OrganizationRole.ADMIN);

    // Soft delete: ab jetzt nur noch lesend (Exportfrist), dann endgueltig.
    // Steht mit ausfuehrender Person im Protokoll der Loeschungen.
    await this.dataSource.transaction(async (manager) => {
      await manager.softRemove(organization);
      await recordDeletion(manager, {
        category: 'organization_closure',
        trigger: 'club',
        organizationId: organization.id,
        executedByUserId: user.id,
        removed: { organizationsClosed: 1 },
      });
    });

    this.logger.log(
      `Organization deleted: ${organization.name} (${organization.id})`,
    );
  }

  /**
   * „Löschung abbrechen“: Ein Admin holt die geloeschte bzw. geschlossene
   * Organisation zurueck, solange sie nicht endgueltig geloescht ist. Wer
   * sein eigenes Konto mitloeschen laesst, bricht stattdessen die
   * Kontoloeschung ab (die holt die Organisation mit zurueck).
   */
  async restore(id: string, user: User): Promise<Organization> {
    const organization = await this.findOne(id, user);
    await this.checkRole(organization.id, user, OrganizationRole.ADMIN);
    if (!organization.deletedAt) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORGANIZATION_NOT_CLOSED,
        message: 'Die Organisation ist nicht gelöscht.',
      });
    }
    if (user.deletionDueAt) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ACCOUNT_DELETION_SCHEDULED,
        message:
          'Dein Konto wird gelöscht. Brich zuerst die Löschung deines Kontos ab – damit kommt auch die Organisation zurück.',
      });
    }
    const restored = await this.dataSource.transaction(async (manager) => {
      const now = new Date();
      if (!(await restoreOrganization(manager, organization.id, now))) {
        return false;
      }
      await recordDeletion(manager, {
        category: 'organization_closure',
        trigger: 'club',
        organizationId: organization.id,
        executedByUserId: user.id,
        removed: {},
        notes: { organizationsRestored: 1 },
        at: now,
      });
      return true;
    });
    if (!restored) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ORGANIZATION_ALREADY_PURGED,
        message: 'Diese Organisation ist bereits endgültig gelöscht.',
      });
    }
    this.logger.log(
      `Organization restored: ${organization.name} (${organization.id})`,
    );
    return this.organizationRepository.findOneOrFail({
      where: { id: organization.id },
    });
  }

  // Member Management
  async getMembers(
    organizationId: string,
    user: User,
    pagination: PaginationDto,
  ): Promise<PaginatedResult<MemberView>> {
    // Die Mitgliederliste (Namen, E-Mail-Adressen, Rechte) sehen nur, die
    // Mitglieder verwalten: Admins und das Mitgliederrecht.
    await this.checkPermission(organizationId, user, 'members');

    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const [items, total] = await this.userOrganizationRepository.findAndCount({
      where: { organizationId },
      relations: ['user'],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    // PIN nie ausliefern, nur ob es eine gibt: alte bcrypt-PIN oder ein
    // Eintrag im gemeinsamen PIN-Raum (pin_credentials, Bedienungen).
    const credentials: { owner_id: string }[] = items.length
      ? await this.dataSource.query(
          `SELECT owner_id FROM pin_credentials WHERE owner_type = 'member' AND owner_id = ANY($1::uuid[])`,
          [items.map((m) => m.id)],
        )
      : [];
    const withCredential = new Set(credentials.map((row) => row.owner_id));
    const mappedItems = items.map((member) =>
      memberView(member, !!member.pin || withCredential.has(member.id)),
    );

    return createPaginatedResult(mappedItems, total, page, limit);
  }

  async addMember(
    organizationId: string,
    addMemberDto: AddMemberDto,
    currentUser: User,
  ): Promise<UserOrganization> {
    // Check if current user is admin or has members permission
    const actor = await this.checkPermission(
      organizationId,
      currentUser,
      'members',
    );
    assertCanGrant(actor, addMemberDto.role, addMemberDto.permissions);

    const wantsNewAccount = addMemberDto.password !== undefined;
    if (wantsNewAccount && actor.role !== OrganizationRole.ADMIN) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ADMIN_REQUIRED_FOR_START_PASSWORD,
        message: 'Nur Admins können Konten mit Startpasswort anlegen',
      });
    }

    // Find user by email
    let user = await this.userRepository.findOne({
      where: { email: addMemberDto.email.toLowerCase() },
    });

    if (user && wantsNewAccount && this.deployment.isSelfHosted) {
      /* Ein Startpasswort fuer ein bestehendes Konto wuerde sonst still
         ignoriert — wer es weitergibt, gaebe ein Passwort weiter, das nicht
         gilt. Bestehende Konten werden ohne Passwort hinzugefuegt. */
      throw new ConflictException({
        code: ErrorCodes.USER_EXISTS,
        reason: ErrorReasons.MEMBER_ACCOUNT_EXISTS,
        message:
          'Zu dieser E-Mail-Adresse gibt es bereits ein Konto. ' +
          'Bitte ohne Startpasswort hinzufügen.',
      });
    }

    if (!user) {
      user = await this.createMemberAccount(addMemberDto);
    }

    if (user.deletionDueAt) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.ACCOUNT_DELETION_SCHEDULED,
        message:
          'Dieses Konto wird gerade gelöscht und kann keiner Organisation beitreten.',
      });
    }

    // Check if already a member
    const existingMember = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: user.id },
    });

    if (existingMember) {
      throw new ConflictException({
        code: ErrorCodes.MEMBER_ALREADY_EXISTS,
        message: 'Benutzer ist bereits Mitglied',
      });
    }

    const userOrganization = this.userOrganizationRepository.create({
      organizationId,
      userId: user.id,
      role: addMemberDto.role,
      permissions:
        addMemberDto.role === OrganizationRole.ADMIN
          ? {}
          : addMemberDto.permissions || {},
    });

    await this.dataSource.transaction(async (manager) => {
      await this.limits.assertMemberSeatAvailable(
        organizationId,
        currentUser,
        manager,
      );
      await manager.save(userOrganization);
    });

    this.logger.log(
      `Member added to organization ${organizationId}: ${user.email}`,
    );

    return this.userOrganizationRepository.findOneOrFail({
      where: { id: userOrganization.id },
      relations: ['user'],
    });
  }

  async updateMember(
    organizationId: string,
    memberId: string,
    updateDto: UpdateMemberDto,
    currentUser: User,
  ): Promise<UserOrganization> {
    // Check if current user is admin or has members permission
    const actor = await this.checkPermission(
      organizationId,
      currentUser,
      'members',
    );

    const member = await this.userOrganizationRepository.findOne({
      where: { id: memberId, organizationId },
      relations: ['user'],
    });

    if (!member) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.MEMBER_NOT_FOUND,
        message: 'Mitglied nicht gefunden',
      });
    }

    // Admins only by admins; other members keep rights the actor lacks
    if (member.role === OrganizationRole.ADMIN) {
      assertCanManage(actor, member);
    }
    assertCanGrant(
      actor,
      updateDto.role ?? member.role,
      updateDto.permissions,
      member.permissions,
    );

    // Keep at least one admin — also when someone else demotes the last one
    if (
      member.role === OrganizationRole.ADMIN &&
      updateDto.role &&
      updateDto.role !== OrganizationRole.ADMIN
    ) {
      const adminCount = await this.userOrganizationRepository.count({
        where: { organizationId, role: OrganizationRole.ADMIN },
      });

      if (adminCount <= 1) {
        throw new BadRequestException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.LAST_ADMIN_REQUIRED,
          message: 'Mindestens ein Admin muss bestehen bleiben',
        });
      }
    }

    if (updateDto.role !== undefined) {
      member.role = updateDto.role;
    }
    if (updateDto.permissions !== undefined) {
      // Admins don't need permissions
      member.permissions =
        member.role === OrganizationRole.ADMIN ? {} : updateDto.permissions;
    }

    await this.userOrganizationRepository.save(member);

    this.logger.log(
      `Member updated in organization ${organizationId}: ${member.user.email}`,
    );

    return member;
  }

  async removeMember(
    organizationId: string,
    memberId: string,
    currentUser: User,
  ): Promise<void> {
    // Check if current user is admin or has members permission
    const actor = await this.checkPermission(
      organizationId,
      currentUser,
      'members',
    );

    const member = await this.userOrganizationRepository.findOne({
      where: { id: memberId, organizationId },
      relations: ['user'],
    });

    if (!member) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.MEMBER_NOT_FOUND,
        message: 'Mitglied nicht gefunden',
      });
    }

    assertCanManage(actor, member);

    // Prevent removing last admin
    if (member.role === OrganizationRole.ADMIN) {
      const adminCount = await this.userOrganizationRepository.count({
        where: { organizationId, role: OrganizationRole.ADMIN },
      });

      if (adminCount <= 1) {
        throw new BadRequestException({
          code: ErrorCodes.FORBIDDEN,
          reason: ErrorReasons.LAST_ADMIN_REQUIRED,
          message: 'Der letzte Admin kann nicht entfernt werden',
        });
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(UserOrganization, { id: member.id });
      // Kassen-PIN und offene Kassen-Sitzungen des Mitglieds enden mit.
      await manager.query(
        `DELETE FROM pin_credentials WHERE owner_type = 'member' AND owner_id = $1`,
        [member.id],
      );
      await manager.query(
        `UPDATE waiter_sessions SET ended_at = now(), end_reason = 'revoked', updated_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND ended_at IS NULL`,
        [member.organizationId, member.userId],
      );
      await recordDeletion(manager, {
        category: 'memberships',
        trigger: 'club',
        organizationId,
        executedByUserId: currentUser.id,
        removed: { membershipsDeleted: 1 },
        details: { membershipId: member.id, userId: member.userId },
      });
    });

    this.logger.log(
      `Member removed from organization ${organizationId}: ${member.user.email}`,
    );
  }

  // Invitation Management
  async createInvitation(
    organizationId: string,
    createDto: CreateInvitationDto,
    currentUser: User,
  ): Promise<Invitation> {
    // Check if current user is admin or has members permission
    const actor = await this.checkPermission(
      organizationId,
      currentUser,
      'members',
    );
    assertCanGrant(actor, createDto.role, createDto.permissions);

    const organization = await this.organizationRepository.findOneOrFail({
      where: { id: organizationId },
    });

    // Check if user already exists and is a member
    const existingUser = await this.userRepository.findOne({
      where: { email: createDto.email.toLowerCase() },
    });

    if (existingUser) {
      const existingMember = await this.userOrganizationRepository.findOne({
        where: { organizationId, userId: existingUser.id },
      });

      if (existingMember) {
        throw new ConflictException({
          code: ErrorCodes.MEMBER_ALREADY_EXISTS,
          message: 'Benutzer ist bereits Mitglied',
        });
      }
    }

    // Check for existing pending invitation
    const existingInvitation = await this.invitationRepository.findOne({
      where: {
        organizationId,
        email: createDto.email.toLowerCase(),
        acceptedAt: undefined,
      },
    });

    if (existingInvitation && existingInvitation.expiresAt > new Date()) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.INVITATION_ALREADY_EXISTS,
        message: 'Eine Einladung für diese E-Mail existiert bereits',
      });
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    const invitation = this.invitationRepository.create({
      organization,
      organizationId,
      email: createDto.email.toLowerCase(),
      role: createDto.role,
      permissions:
        createDto.role === OrganizationRole.ADMIN
          ? {}
          : createDto.permissions || {},
      token,
      expiresAt,
      invitedByUser: currentUser,
      invitedByUserId: currentUser.id,
    });

    // Eine offene Einladung belegt ihren Platz schon jetzt; die Sperre auf
    // der Organisationszeile haelt gleichzeitige Einladungen auseinander.
    await this.dataSource.transaction(async (manager) => {
      await this.limits.assertMemberSeatAvailable(
        organizationId,
        currentUser,
        manager,
      );
      await manager.save(invitation);
    });

    // Send invitation email
    const appUrl =
      this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    const acceptUrl = `${appUrl}/de/invitations/${token}`;
    const inviterName =
      `${currentUser.firstName} ${currentUser.lastName}`.trim() ||
      currentUser.email;

    await this.emailService.sendInvitationEmail(
      createDto.email,
      organization.name,
      inviterName,
      acceptUrl,
      createDto.role,
    );

    this.logger.log(
      `Invitation created for ${createDto.email} to organization ${organizationId}`,
    );

    return invitation;
  }

  async getInvitations(
    organizationId: string,
    user: User,
  ): Promise<Invitation[]> {
    await this.checkPermission(organizationId, user, 'members');

    return this.invitationRepository.find({
      where: { organizationId, acceptedAt: IsNull() },
      relations: ['invitedByUser'],
      order: { createdAt: 'DESC' },
    });
  }

  async cancelInvitation(
    organizationId: string,
    invitationId: string,
    user: User,
  ): Promise<void> {
    const actor = await this.checkPermission(organizationId, user, 'members');

    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, organizationId },
    });

    if (!invitation) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.INVITATION_NOT_FOUND,
        message: 'Einladung nicht gefunden',
      });
    }

    assertCanManage(actor, invitation);

    await this.invitationRepository.remove(invitation);

    this.logger.log(`Invitation cancelled: ${invitationId}`);
  }

  async resendInvitation(
    organizationId: string,
    invitationId: string,
    currentUser: User,
  ): Promise<void> {
    const actor = await this.checkPermission(
      organizationId,
      currentUser,
      'members',
    );

    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, organizationId },
      relations: ['organization'],
    });

    // Ohne Organisation: geloescht (die Relation laedt sie nicht mehr).
    if (!invitation || !invitation.organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.INVITATION_NOT_FOUND,
        message: 'Einladung nicht gefunden',
      });
    }

    assertCanManage(actor, invitation);

    if (invitation.isExpired()) {
      throw new BadRequestException({
        code: ErrorCodes.INVITATION_EXPIRED,
        message: 'Einladung ist abgelaufen',
      });
    }

    if (invitation.isAccepted()) {
      throw new BadRequestException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.INVITATION_ALREADY_ACCEPTED,
        message: 'Einladung wurde bereits angenommen',
      });
    }

    const appUrl =
      this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    const acceptUrl = `${appUrl}/de/invitations/${invitation.token}`;
    const inviterName =
      `${currentUser.firstName} ${currentUser.lastName}`.trim() ||
      currentUser.email;

    await this.emailService.sendInvitationEmail(
      invitation.email,
      invitation.organization.name,
      inviterName,
      acceptUrl,
      invitation.role,
    );

    this.logger.log(
      `Invitation resent: ${invitationId} to ${invitation.email}`,
    );
  }

  async getInvitationByToken(token: string): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
      relations: ['organization'],
    });

    if (!invitation) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        reason: ErrorReasons.INVITATION_NOT_FOUND,
        message: 'Einladung nicht gefunden',
      });
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException({
        code: ErrorCodes.INVITATION_EXPIRED,
        message: 'Einladung ist abgelaufen',
      });
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.INVITATION_ALREADY_ACCEPTED,
        message: 'Einladung wurde bereits angenommen',
      });
    }

    return invitation;
  }

  async acceptInvitation(token: string, user: User): Promise<UserOrganization> {
    const invitation = await this.getInvitationByToken(token);

    // Check if email matches
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INVITATION_EMAIL_MISMATCH,
        message: 'Diese Einladung ist für eine andere E-Mail-Adresse',
      });
    }

    // Check if already a member
    const existingMember = await this.userOrganizationRepository.findOne({
      where: { organizationId: invitation.organizationId, userId: user.id },
    });

    if (existingMember) {
      throw new ConflictException({
        code: ErrorCodes.MEMBER_ALREADY_EXISTS,
        reason: ErrorReasons.ALREADY_MEMBER,
        message: 'Du bist bereits Mitglied dieser Organisation',
      });
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Der Platz in der Organisation ist seit der Einladung belegt; hier
      // zaehlt nur noch, ob der Eingeladene selbst noch Organisationen
      // dazunehmen darf.
      await this.limits.assertCanJoinOrganization(user, queryRunner.manager);

      // Create membership with permissions from invitation
      const userOrganization = this.userOrganizationRepository.create({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
        permissions: invitation.permissions || {},
      });
      await queryRunner.manager.save(userOrganization);

      // Mark invitation as accepted
      invitation.acceptedAt = new Date();
      await queryRunner.manager.save(invitation);

      await queryRunner.commitTransaction();

      this.logger.log(
        `Invitation accepted: ${user.email} joined organization ${invitation.organizationId}`,
      );

      return this.userOrganizationRepository.findOneOrFail({
        where: { id: userOrganization.id },
        relations: ['organization'],
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async declineInvitation(token: string, user: User): Promise<void> {
    const invitation = await this.getInvitationByToken(token);

    // Check if email matches
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INVITATION_EMAIL_MISMATCH,
        message: 'Diese Einladung ist für eine andere E-Mail-Adresse',
      });
    }

    // Delete the invitation
    await this.invitationRepository.remove(invitation);

    this.logger.log(
      `Invitation declined: ${user.email} declined invitation to organization ${invitation.organizationId}`,
    );
  }

  // Helper methods
  async checkMembership(
    organizationId: string,
    user: User,
  ): Promise<UserOrganization> {
    if (user.isSuperAdmin) {
      return { role: OrganizationRole.ADMIN } as UserOrganization;
    }

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: user.id },
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

  async checkRole(
    organizationId: string,
    user: User,
    requiredRole: OrganizationRole,
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, user);

    const roleHierarchy: Record<OrganizationRole, number> = {
      [OrganizationRole.ADMIN]: 80,
      [OrganizationRole.MEMBER]: 20,
    };

    if (roleHierarchy[membership.role] < roleHierarchy[requiredRole]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }

  /**
   * Check if user is admin or has a specific module permission.
   * Admins always pass. Members need the specific permission to be true.
   */
  async checkPermission(
    organizationId: string,
    user: User,
    permission: keyof OrganizationPermissions,
  ): Promise<UserOrganization> {
    const membership = await this.checkMembership(organizationId, user);

    // Admins have all permissions
    if (membership.role === OrganizationRole.ADMIN) {
      return membership;
    }

    // Members need the specific permission
    if (!membership.permissions?.[permission]) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }

    return membership;
  }

  async verifyMemberAccess(
    organizationId: string,
    user: User,
    allowedRoles: string[],
  ): Promise<UserOrganization> {
    // Super admins always have access
    if (user.isSuperAdmin) {
      return { role: OrganizationRole.ADMIN } as UserOrganization;
    }

    const membership = await this.checkMembership(organizationId, user);

    if (!allowedRoles.includes(membership.role)) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen für diese Aktion',
      });
    }

    return membership;
  }

  private async generateSlug(name: string): Promise<string> {
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

    while (await this.organizationRepository.findOne({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    return slug;
  }

  private generateSupportPin(): string {
    // Sechsstellig wie bisher (100000–999999), aber aus crypto statt Math.random.
    return crypto.randomInt(100000, 1000000).toString();
  }
}
