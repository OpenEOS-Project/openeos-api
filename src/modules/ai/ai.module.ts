import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsage } from '../../database/entities';
import { AI_PROVIDER } from './ai-provider.interface';
import { createAiProvider, readAiConfig } from './ai-provider.factory';
import { AiQuotaService } from './ai-quota.service';

/**
 * Modellanbieter und Kontingente. Global, weil der Anbieter an einer
 * Stelle aus `AI_PROVIDER` gebaut wird und jedes Assistent-Feature ihn
 * braucht — der Assistent selbst (Import, Icons) liegt in AssistantModule.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AiUsage])],
  providers: [
    {
      provide: AI_PROVIDER,
      useFactory: (configService: ConfigService) =>
        createAiProvider(readAiConfig(configService)),
      inject: [ConfigService],
    },
    AiQuotaService,
  ],
  exports: [AI_PROVIDER, AiQuotaService],
})
export class AiModule {}
