import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AdminAction,
  AdminAuditLog,
  Organization,
  User,
} from '../../database/entities';
import { OrganizationRole } from '../../database/entities/user-organization.entity';
import { ErrorCodes, ErrorMessages } from '../../common/constants/error-codes';
import { OrganizationsService } from '../organizations/organizations.service';
import { AI_PROVIDER } from '../ai/ai-provider.interface';
import type { AiProvider } from '../ai/ai-provider.interface';
import { AiQuotaService, QuotaStatus } from '../ai/ai-quota.service';

export interface AssistantStatus {
  enabled: boolean;
  /** Ein Anbieter ist konfiguriert (AI_PROVIDER + Schluessel). */
  available: boolean;
  /** Der Anbieter liest PDF-Seiten direkt; sonst nimmt der Import nur Bilder. */
  pdfSupported: boolean;
  quotas: {
    menuImports: QuotaStatus;
    classifications: QuotaStatus;
  };
}

export interface AuditClient {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Opt-in der Organisation fuer die Assistent-Funktionen (ki-plan.md 6.2)
 * und die gemeinsame Zugangspruefung fuer alle Assistent-Endpunkte.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
    private readonly organizationsService: OrganizationsService,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly quota: AiQuotaService,
  ) {}

  isEnabled(organization: Pick<Organization, 'settings'>): boolean {
    return organization.settings?.assistant?.enabled === true;
  }

  async getStatus(
    organizationId: string,
    user: User,
  ): Promise<AssistantStatus> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    return this.statusOf(organization);
  }

  async setEnabled(
    organizationId: string,
    enabled: boolean,
    user: User,
    client: AuditClient = {},
  ): Promise<AssistantStatus> {
    const organization = await this.organizationsService.findOne(
      organizationId,
      user,
    );
    await this.organizationsService.checkRole(
      organization.id,
      user,
      OrganizationRole.ADMIN,
    );

    const before = this.isEnabled(organization);
    if (before !== enabled) {
      const entry = enabled
        ? {
            enabled: true,
            enabledAt: new Date().toISOString(),
            enabledByUserId: user.id,
          }
        : { enabled: false };
      // Gezielt nur `settings.assistant` schreiben (jsonb), wie bei den
      // Integrationen — maskierte Zugangsdaten bleiben unberuehrt.
      await this.organizationRepository.query(
        `UPDATE organizations
            SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{assistant}', $2::jsonb, true),
                updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [organization.id, JSON.stringify(entry)],
      );
      await this.audit(
        enabled
          ? AdminAction.ASSISTANT_ENABLED
          : AdminAction.ASSISTANT_DISABLED,
        organization.id,
        user,
        client,
        { before: { enabled: before }, after: entry },
      );
      this.logger.log(
        `Assistent ${enabled ? 'eingeschaltet' : 'ausgeschaltet'} für Organisation ${organization.id}`,
      );
    }

    return this.statusOf(
      await this.organizationsService.findOne(organization.id, user),
    );
  }

  /**
   * Darf diese Organisation den Assistenten nutzen? 404 AI_DISABLED ohne
   * Anbieter, 403 ASSISTANT_DISABLED ohne Opt-in. Die Mitgliedschaft hat
   * der Aufrufer vorher geprueft.
   */
  async assertUsable(organizationId: string): Promise<Organization> {
    if (!this.provider.isAvailable()) {
      throw new NotFoundException({
        code: ErrorCodes.AI_DISABLED,
        message: ErrorMessages[ErrorCodes.AI_DISABLED],
      });
    }
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization || !this.isEnabled(organization)) {
      throw new ForbiddenException({
        code: ErrorCodes.ASSISTANT_DISABLED,
        message: ErrorMessages[ErrorCodes.ASSISTANT_DISABLED],
      });
    }
    return organization;
  }

  async recordAudit(
    action: AdminAction,
    organizationId: string,
    user: User,
    client: AuditClient,
    details: Record<string, unknown>,
    resource: { type: string; id: string | null } = {
      type: 'organization',
      id: organizationId,
    },
  ): Promise<void> {
    try {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          adminUserId: user.id,
          organizationId,
          action,
          resourceType: resource.type,
          resourceId: resource.id,
          details,
          ipAddress: (client.ipAddress || 'unknown').slice(0, 45),
          userAgent: client.userAgent?.slice(0, 500) ?? null,
        }),
      );
    } catch (error) {
      // Best effort: ein fehlender Protokolleintrag dreht die Aktion nicht zurueck.
      this.logger.error(
        `Protokolleintrag ${action} nicht geschrieben: ${(error as Error).message}`,
      );
    }
  }

  private audit(
    action: AdminAction,
    organizationId: string,
    user: User,
    client: AuditClient,
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.recordAudit(action, organizationId, user, client, details);
  }

  private async statusOf(organization: Organization): Promise<AssistantStatus> {
    const [menuImports, classifications] = await Promise.all([
      this.quota.getQuota(organization.id, 'menu_import'),
      this.quota.getQuota(organization.id, 'icon_suggest'),
    ]);
    return {
      enabled: this.isEnabled(organization),
      available: this.provider.isAvailable(),
      pdfSupported: this.provider.supportsPdf(),
      quotas: { menuImports, classifications },
    };
  }
}
