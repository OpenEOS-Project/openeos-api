import { SupportMessageDirection } from '../../database/entities/support-message.entity';

export interface SupportMessageDto {
  id: string;
  direction: SupportMessageDirection;
  body: string;
  senderName: string;
  createdAt: Date;
}

export interface SupportThreadSummaryDto {
  organizationId: string;
  organizationName: string;
  prioritySupport: boolean;
  lastMessageAt: Date;
  lastMessagePreview: string;
  unreadCount: number;
}
