import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// Initialize Sentry before anything else
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.npm_package_version || '0.0.1',

  // Performance Monitoring
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

  // Profiling (only in production)
  profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,

  integrations: [
    // Add profiling integration
    nodeProfilingIntegration(),
  ],

  // Filter out health check transactions
  ignoreTransactions: [
    '/api/health',
    '/api/health/ready',
    '/api/health/live',
    '/api/health/detailed',
  ],

  // Don't send errors in development unless DSN is set
  enabled: !!process.env.SENTRY_DSN,

  // Add context to errors
  beforeSend(event) {
    // Don't send events in test environment
    if (process.env.NODE_ENV === 'test') {
      return null;
    }
    return event;
  },
});
