import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Event, Organization, SupportMessage, User, UserOrganization } from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';
import { SendSupportMessageDto } from './dto';
import { SupportMessageDto, SupportThreadSummaryDto } from './support.types';
import { TelegramSupportService } from './telegram-support.service';
import { EmailService } from '../email/email.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

const PRIORITY_EVENT_STATUSES = ['paid', 'invoice'];
const PRIORITY_EVENT_WINDOW_MONTHS = 12;
const MEMBER_MESSAGE_LIMIT = 200;
const ADMIN_MESSAGE_LIMIT = 500;
const PREVIEW_LENGTH = 80;

interface SupportThreadRow {
  organizationId: string;
  organizationName: string;
  prioritySupportFlag: boolean;
  lastMessagePreview: string;
  lastMessageAt: Date;
  unreadCount: string;
}

/**
 * Support-Chat: ein fortlaufender Thread je Organisation zwischen
 * Vereinsmitgliedern und dem Plattform-Support, gespiegelt nach Telegram.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportMessage)
    private readonly supportMessageRepository: Repository<SupportMessage>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private readonly userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    private readonly telegramSupportService: TelegramSupportService,
    private readonly emailService: EmailService,
    private readonly platformSettingsService: PlatformSettingsService,
  ) {}

  // === Member-facing ===

  async getMemberThread(
    organizationId: string,
    user: User,
  ): Promise<{ prioritySupport: boolean; messages: SupportMessageDto[] }> {
    await this.checkMembership(organizationId, user.id);
    const organization = await this.getOrganizationOrFail(organizationId);

    // Chat geöffnet = gelesen: unread Support-Antworten als gelesen markieren.
    await this.supportMessageRepository.update(
      { organizationId, direction: 'outbound', readByUserAt: IsNull() },
      { readByUserAt: new Date() },
    );

    const messages = await this.findRecentMessages(organizationId, MEMBER_MESSAGE_LIMIT);

    return {
      prioritySupport: await this.isPrioritySupport(organization),
      messages: messages.map((message) => this.mapMessage(message)),
    };
  }

  async postMemberMessage(
    organizationId: string,
    user: User,
    dto: SendSupportMessageDto,
  ): Promise<SupportMessageDto> {
    await this.checkMembership(organizationId, user.id);
    const organization = await this.getOrganizationOrFail(organizationId);
    const body = this.assertNonEmptyBody(dto.body);

    const message = this.supportMessageRepository.create({
      organizationId,
      userId: user.id,
      direction: 'inbound',
      body,
    });
    await this.supportMessageRepository.save(message);

    try {
      const priority = await this.isPrioritySupport(organization);
      const telegramMessageId = await this.telegramSupportService.notifyInboundMessage(
        organization,
        user.fullName,
        body,
        priority,
      );
      if (telegramMessageId) {
        message.telegramMessageId = String(telegramMessageId);
        await this.supportMessageRepository.save(message);
      }
    } catch (error) {
      this.logger.warn(
        `Telegram-Weiterleitung fehlgeschlagen für Organisation ${organizationId}: ${(error as Error).message}`,
      );
    }

    // Admin-E-Mail nur für die ERSTE ungelesene Nachricht eines Schwungs —
    // solange der Admin nicht gelesen hat, lösen Folgenachrichten keine Mail aus.
    try {
      const unreadInbound = await this.supportMessageRepository.count({
        where: { organizationId, direction: 'inbound', readByAdminAt: IsNull() },
      });
      if (unreadInbound === 1) {
        const notifyEmail = await this.platformSettingsService.resolveNotificationTarget('supportMessage');
        if (notifyEmail) {
          await this.emailService.sendAdminSupportMessageNotification({
            to: notifyEmail,
            organizationName: organization.name,
            senderName: user.fullName,
            preview: body.length > 200 ? `${body.slice(0, 200)}…` : body,
            priority: await this.isPrioritySupport(organization),
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Admin-Benachrichtigung (Support) fehlgeschlagen für Organisation ${organizationId}: ${(error as Error).message}`,
      );
    }

    return this.mapMessage(message, user.fullName);
  }

  // === Super-Admin ===

  async getThreadsForAdmin(): Promise<SupportThreadSummaryDto[]> {
    const rows: SupportThreadRow[] = await this.supportMessageRepository.manager.query(`
      SELECT
        sm.organization_id AS "organizationId",
        o.name AS "organizationName",
        o.priority_support AS "prioritySupportFlag",
        last.body AS "lastMessagePreview",
        last.created_at AS "lastMessageAt",
        COALESCE(unread.count, 0)::int AS "unreadCount"
      FROM (SELECT DISTINCT organization_id FROM support_messages) sm
      JOIN organizations o ON o.id = sm.organization_id
      JOIN LATERAL (
        SELECT body, created_at FROM support_messages m2
        WHERE m2.organization_id = sm.organization_id
        ORDER BY m2.created_at DESC LIMIT 1
      ) last ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS count FROM support_messages m3
        WHERE m3.organization_id = sm.organization_id
          AND m3.direction = 'inbound' AND m3.read_by_admin_at IS NULL
      ) unread ON true
    `);

    const priorityOrgIds = await this.getPriorityOrgIds(rows.map((row) => row.organizationId));

    const threads = rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      prioritySupport: row.prioritySupportFlag === true || priorityOrgIds.has(row.organizationId),
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview.slice(0, PREVIEW_LENGTH),
      unreadCount: Number(row.unreadCount),
    }));

    threads.sort((a, b) => {
      if (a.prioritySupport !== b.prioritySupport) {
        return a.prioritySupport ? -1 : 1;
      }
      return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    });

    return threads;
  }

  async getMessagesForAdmin(organizationId: string): Promise<SupportMessageDto[]> {
    await this.getOrganizationOrFail(organizationId);

    await this.supportMessageRepository.update(
      { organizationId, direction: 'inbound', readByAdminAt: IsNull() },
      { readByAdminAt: new Date() },
    );

    const messages = await this.findRecentMessages(organizationId, ADMIN_MESSAGE_LIMIT);

    return messages.map((message) => this.mapMessage(message));
  }

  async postAdminMessage(organizationId: string, dto: SendSupportMessageDto): Promise<SupportMessageDto> {
    const organization = await this.getOrganizationOrFail(organizationId);
    const body = this.assertNonEmptyBody(dto.body);

    const message = this.supportMessageRepository.create({
      organizationId,
      userId: null,
      direction: 'outbound',
      body,
    });
    await this.supportMessageRepository.save(message);

    try {
      const priority = await this.isPrioritySupport(organization);
      const telegramMessageId = await this.telegramSupportService.mirrorAdminReply(organization, body, priority);
      if (telegramMessageId) {
        message.telegramMessageId = String(telegramMessageId);
        await this.supportMessageRepository.save(message);
      }
    } catch (error) {
      this.logger.warn(
        `Telegram-Spiegelung fehlgeschlagen für Organisation ${organizationId}: ${(error as Error).message}`,
      );
    }

    return this.mapMessage(message);
  }

  // === Shared helpers ===

  /**
   * `organization.prioritySupport` (manueller Admin-Schalter) ODER ein Event
   * der Organisation mit `billingStatus` in (paid, invoice), zuletzt
   * aktualisiert innerhalb der letzten 12 Monate (zahlende Organisation).
   */
  async isPrioritySupport(organization: Organization): Promise<boolean> {
    if (organization.prioritySupport) return true;
    const priorityOrgIds = await this.getPriorityOrgIds([organization.id]);
    return priorityOrgIds.has(organization.id);
  }

  private async getPriorityOrgIds(organizationIds: string[]): Promise<Set<string>> {
    if (!organizationIds.length) return new Set();

    const since = new Date();
    since.setMonth(since.getMonth() - PRIORITY_EVENT_WINDOW_MONTHS);

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .select('DISTINCT event.organizationId', 'organizationId')
      .where('event.organizationId IN (:...organizationIds)', { organizationIds })
      .andWhere('event.billingStatus IN (:...statuses)', { statuses: PRIORITY_EVENT_STATUSES })
      .andWhere('event.updatedAt > :since', { since })
      .getRawMany<{ organizationId: string }>();

    return new Set(rows.map((row) => row.organizationId));
  }

  private async findRecentMessages(organizationId: string, limit: number): Promise<SupportMessage[]> {
    const recent = await this.supportMessageRepository.find({
      where: { organizationId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return recent.reverse();
  }

  private mapMessage(message: SupportMessage, senderNameOverride?: string): SupportMessageDto {
    const senderName =
      message.direction === 'outbound'
        ? 'OpenEOS Support'
        : senderNameOverride ?? message.user?.fullName ?? 'Unbekannt';

    return {
      id: message.id,
      direction: message.direction,
      body: message.body,
      senderName,
      createdAt: message.createdAt,
    };
  }

  private assertNonEmptyBody(rawBody: string): string {
    const body = rawBody.trim();
    if (!body) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Nachricht darf nicht leer sein',
      });
    }
    return body;
  }

  private async getOrganizationOrFail(organizationId: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({ where: { id: organizationId } });
    if (!organization) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Organisation nicht gefunden',
      });
    }
    return organization;
  }

  private async checkMembership(organizationId: string, userId: string): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }

    return membership;
  }
}
