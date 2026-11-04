import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RetentionNotice, RetentionRun } from '../../database/entities';
import { AssistantModule } from '../assistant';
import { MenuImportWorkerService } from '../assistant/menu-import/menu-import-worker.service';
import { tseSettingsFromEnv } from '../tse/tse.config';
import { AssistantImportsJob } from './jobs/assistant-imports.job';
import { AuditLogsJob } from './jobs/audit-logs.job';
import { AuthRecordsJob } from './jobs/auth-records.job';
import { ContactRequestsJob } from './jobs/contact-requests.job';
import { FiscalArchiveJob } from './jobs/fiscal-archive.job';
import { GuestDataJob } from './jobs/guest-data.job';
import { HelperDataJob } from './jobs/helper-data.job';
import { OrganizationInactivityJob } from './jobs/organization-inactivity.job';
import { OrganizationPurgeJob } from './jobs/organization-purge.job';
import { SupportMessagesJob } from './jobs/support-messages.job';
import { UserAccountsJob } from './jobs/user-accounts.job';
import { RetentionAdminController } from './retention-admin.controller';
import { RETENTION_CONFIG, loadRetentionConfig } from './retention.config';
import { RetentionErasureService } from './retention-erasure.service';
import { RetentionNoticeService } from './retention-notice.service';
import { RetentionService } from './retention.service';
import { RETENTION_JOBS, type RetentionJob } from './retention.types';

/**
 * Aufbewahrung und Loeschung: ein naechtlicher Lauf je Datenart mit
 * Protokoll, Ankuendigungen vor Schliessung und Loeschung, Einzelloeschung
 * auf Weisung. Siehe README „Aufbewahrung und Löschung“.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RetentionRun, RetentionNotice]),
    AssistantModule,
  ],
  controllers: [RetentionAdminController],
  providers: [
    { provide: RETENTION_CONFIG, useFactory: () => loadRetentionConfig() },
    RetentionNoticeService,
    {
      provide: RETENTION_JOBS,
      inject: [ConfigService, RetentionNoticeService, MenuImportWorkerService],
      useFactory: (
        config: ConfigService,
        notices: RetentionNoticeService,
        menuImports: MenuImportWorkerService,
      ): RetentionJob[] => {
        const uploadDir = config.get<string>('UPLOAD_DIR') || './uploads';
        const options = {
          uploadDir,
          fiscalExportDir: tseSettingsFromEnv(process.env).exportDir,
          contactEmail:
            config.get<string>('RETENTION_CONTACT_EMAIL') ||
            config.get<string>('OPERATOR_EMAIL') ||
            null,
        };
        return [
          new GuestDataJob(),
          new HelperDataJob(),
          new AuthRecordsJob(),
          new AuditLogsJob(),
          new SupportMessagesJob(),
          new ContactRequestsJob(),
          new AssistantImportsJob(menuImports),
          new OrganizationInactivityJob(notices),
          new OrganizationPurgeJob(notices, options),
          new UserAccountsJob(notices, options),
          new FiscalArchiveJob(),
        ];
      },
    },
    RetentionService,
    RetentionErasureService,
  ],
  exports: [RetentionService],
})
export class RetentionModule {}
