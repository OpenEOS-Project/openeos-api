import { Global, Module } from '@nestjs/common';

import { TargetLimitService } from './target-limit.service';

/** Grenzen je Ziel (Empfaenger), fuer alle Module verfuegbar. */
@Global()
@Module({
  providers: [TargetLimitService],
  exports: [TargetLimitService],
})
export class RateLimitModule {}
