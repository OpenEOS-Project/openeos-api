import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organization, SupportMessage } from '../../database/entities';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

const OFFSET_SETTING_KEY = 'supportTelegramOffset';
const WEBSITE_TOPIC_SETTING_KEY = 'supportTelegramWebsiteTopicId';
const POLL_INTERVAL_MS = 4000;
const REQUEST_TIMEOUT_MS = 8000;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Bridges den Support-Chat einer Organisation in eine Telegram-Themengruppe
 * (Forum), ein Thema je Organisation. Ist nur aktiv, wenn sowohl Bot-Token
 * als auch Chat-ID konfiguriert sind (SUPPORT_TELEGRAM_BOT_TOKEN /
 * SUPPORT_TELEGRAM_CHAT_ID) — ansonsten sind alle Methoden No-Ops.
 */
@Injectable()
export class TelegramSupportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramSupportService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  readonly enabled: boolean;

  private pollTimer?: NodeJS.Timeout;
  private pollingInFlight = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(SupportMessage)
    private readonly supportMessageRepository: Repository<SupportMessage>,
    private readonly platformSettingsService: PlatformSettingsService,
  ) {
    this.botToken = this.configService.get<string>('support.telegramBotToken') || '';
    this.chatId = this.configService.get<string>('support.telegramChatId') || '';
    this.enabled = Boolean(this.botToken && this.chatId);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Telegram-Support-Bridge deaktiviert (SUPPORT_TELEGRAM_BOT_TOKEN/SUPPORT_TELEGRAM_CHAT_ID nicht gesetzt)',
      );
      return;
    }

    this.logger.log('Telegram-Support-Bridge aktiv, starte Reply-Polling');
    this.pollTimer = setInterval(() => {
      void this.pollUpdates();
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  /** Nachricht einer eingehenden Kundennachricht in das Organisations-Thema spiegeln. */
  async notifyInboundMessage(
    org: Organization,
    senderName: string,
    body: string,
    effectivePriority: boolean,
  ): Promise<number | null> {
    if (!this.enabled) return null;
    const text = `👤 ${senderName}${effectivePriority ? ' · 🚨 PRIORITY' : ''}\n✅ Authentifizierter Benutzer\n\n${body}`;
    return this.sendToTopic(org, text, effectivePriority);
  }

  /** Antwort eines Admins zusätzlich ins Thema spiegeln, damit die Telegram-Historie vollständig bleibt. */
  async mirrorAdminReply(org: Organization, body: string, effectivePriority: boolean): Promise<number | null> {
    if (!this.enabled) return null;
    const text = `💬 Antwort (via Plattform):\n\n${body}`;
    return this.sendToTopic(org, text, effectivePriority);
  }

  /**
   * Sendet eine nicht-authentifizierte Website-Anfrage (Demo/Kontakt/Hardware/
   * Gateway) in ein einziges, geteiltes Forum-Thema „🌐 Website-Anfragen“.
   * Läuft unabhängig vom E-Mail-Benachrichtigungs-Toggle, wie auch der
   * Support-Chat.
   */
  async sendWebsiteInquiry(text: string): Promise<number | null> {
    if (!this.enabled) return null;
    return this.sendToWebsiteTopic(text);
  }

  private async sendToWebsiteTopic(text: string, allowRecreate = true): Promise<number | null> {
    const topicId = await this.ensureWebsiteTopic();
    if (!topicId) return null;

    const response = await this.request<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      message_thread_id: topicId,
      text,
    });

    if (response?.ok && response.result) {
      return response.result.message_id;
    }

    if (allowRecreate && this.isTopicNotFoundError(response)) {
      this.logger.warn('Telegram-Website-Thema nicht mehr vorhanden, lege es neu an');
      await this.platformSettingsService.setValue(WEBSITE_TOPIC_SETTING_KEY, null);
      return this.sendToWebsiteTopic(text, false);
    }

    this.logger.warn(`Telegram sendMessage (Website-Thema) fehlgeschlagen: ${response?.description}`);
    return null;
  }

  private async ensureWebsiteTopic(): Promise<number | null> {
    const existing = await this.platformSettingsService.getValue<number>(WEBSITE_TOPIC_SETTING_KEY);
    if (existing) return existing;

    const response = await this.request<{ message_thread_id: number }>('createForumTopic', {
      chat_id: this.chatId,
      name: '🌐 Website-Anfragen',
    });

    if (!response?.ok || !response.result) {
      this.logger.warn(`Anlegen des Telegram-Website-Themas fehlgeschlagen: ${response?.description}`);
      return null;
    }

    await this.platformSettingsService.setValue(WEBSITE_TOPIC_SETTING_KEY, response.result.message_thread_id);
    return response.result.message_thread_id;
  }

  /** Stellt sicher, dass die Organisation ein Telegram-Thema hat, und legt es bei Bedarf an. */
  async ensureTopicForOrg(org: Organization, effectivePriority: boolean): Promise<number | null> {
    if (!this.enabled) return null;
    if (org.supportTelegramTopicId) return org.supportTelegramTopicId;

    const response = await this.request<{ message_thread_id: number }>('createForumTopic', {
      chat_id: this.chatId,
      name: `${org.name}${effectivePriority ? ' 🚨' : ''}`,
    });

    if (!response?.ok || !response.result) {
      this.logger.warn(`Anlegen des Telegram-Themas fehlgeschlagen für Organisation ${org.id}: ${response?.description}`);
      return null;
    }

    org.supportTelegramTopicId = response.result.message_thread_id;
    await this.organizationRepository.update(org.id, {
      supportTelegramTopicId: response.result.message_thread_id,
    });

    return response.result.message_thread_id;
  }

  private async sendToTopic(
    org: Organization,
    text: string,
    effectivePriority: boolean,
    allowRecreate = true,
  ): Promise<number | null> {
    const topicId = await this.ensureTopicForOrg(org, effectivePriority);
    if (!topicId) return null;

    const response = await this.request<{ message_id: number }>('sendMessage', {
      chat_id: this.chatId,
      message_thread_id: topicId,
      text,
    });

    if (response?.ok && response.result) {
      return response.result.message_id;
    }

    if (allowRecreate && this.isTopicNotFoundError(response)) {
      this.logger.warn(`Telegram-Thema für Organisation ${org.id} nicht mehr vorhanden, lege es neu an`);
      org.supportTelegramTopicId = null;
      await this.organizationRepository.update(org.id, { supportTelegramTopicId: null });
      return this.sendToTopic(org, text, effectivePriority, false);
    }

    this.logger.warn(`Telegram sendMessage fehlgeschlagen für Organisation ${org.id}: ${response?.description}`);
    return null;
  }

  private isTopicNotFoundError(response: TelegramApiResponse<unknown> | null): boolean {
    return !!response?.description?.toLowerCase().includes('message thread not found');
  }

  private async pollUpdates(): Promise<void> {
    if (!this.enabled || this.pollingInFlight) return;
    this.pollingInFlight = true;

    try {
      const offset = (await this.platformSettingsService.getValue<number>(OFFSET_SETTING_KEY)) ?? undefined;
      const websiteTopicId = await this.platformSettingsService.getValue<number>(WEBSITE_TOPIC_SETTING_KEY);

      const response = await this.request<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: 0,
        allowed_updates: ['message'],
      });

      if (!response?.ok || !response.result?.length) {
        return;
      }

      const updates = response.result;

      const threadIds = [
        ...new Set(
          updates
            .map((update) => update.message?.message_thread_id)
            .filter((id): id is number => typeof id === 'number'),
        ),
      ];

      const organizations = threadIds.length
        ? await this.organizationRepository.find({
            where: threadIds.map((topicId) => ({ supportTelegramTopicId: topicId })),
          })
        : [];
      const orgByTopicId = new Map(organizations.map((org) => [org.supportTelegramTopicId as number, org]));

      for (const update of updates) {
        const message = update.message;
        if (
          message &&
          typeof message.message_thread_id === 'number' &&
          message.message_thread_id !== websiteTopicId &&
          String(message.chat.id) === this.chatId &&
          !message.from?.is_bot &&
          message.text
        ) {
          const org = orgByTopicId.get(message.message_thread_id);
          if (org) {
            const supportMessage = this.supportMessageRepository.create({
              organizationId: org.id,
              userId: null,
              direction: 'outbound',
              body: message.text,
              telegramMessageId: String(message.message_id),
            });
            await this.supportMessageRepository.save(supportMessage);
          }
        }
      }

      const nextOffset = Math.max(...updates.map((update) => update.update_id)) + 1;
      await this.platformSettingsService.setValue(OFFSET_SETTING_KEY, nextOffset);
    } catch (error) {
      this.logger.warn(`Telegram Reply-Polling fehlgeschlagen: ${(error as Error).message}`);
    } finally {
      this.pollingInFlight = false;
    }
  }

  private async request<T>(method: string, body: Record<string, unknown>): Promise<TelegramApiResponse<T> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      return (await res.json()) as TelegramApiResponse<T>;
    } catch (error) {
      this.logger.warn(`Telegram API ${method} Anfrage fehlgeschlagen: ${(error as Error).message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
