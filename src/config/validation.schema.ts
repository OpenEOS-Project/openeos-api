import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api'),
  API_VERSION: Joi.number().default(1),
  // Reverse proxies to trust for X-Forwarded-For (see trust-proxy.util.ts).
  // Unset = loopback, link-local and private networks.
  TRUST_PROXY: Joi.string().allow('').optional(),

  // Database
  DATABASE_HOST: Joi.string().default('localhost'),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USER: Joi.string().default('openeos'),
  // Defaults to the same password docker-compose.yml's dev Postgres service
  // uses, for a zero-config local `docker compose up`. Required (no
  // default) in production, so a misconfigured prod deploy fails at boot
  // instead of silently starting against a well-known weak password.
  DATABASE_PASSWORD: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().default('openeos_dev_password'),
  }),
  DATABASE_NAME: Joi.string().default('openeos'),
  DATABASE_SYNCHRONIZE: Joi.boolean().default(false),
  DATABASE_LOGGING: Joi.boolean().default(true),
  // Connection pool. Defaults live in database.config.ts (POOL_DEFAULTS);
  // this only validates, so a typo fails at boot instead of silently
  // falling back to the default.
  DATABASE_POOL_MAX: Joi.number().integer().min(1),
  DATABASE_POOL_IDLE_TIMEOUT_MS: Joi.number().integer().min(1),
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(1),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_ACCESS_TOKEN_EXPIRATION: Joi.string().default('30m'),
  JWT_REFRESH_TOKEN_EXPIRATION: Joi.string().default('7d'),

  // 2FA email OTP encryption/pepper. EncryptionService already refuses to
  // construct without this in production (throws with a clear message) —
  // listed here too so it fails at the same up-front config-validation
  // step as everything else, instead of at first use of that service.
  TWO_FACTOR_ENCRYPTION_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.string().allow('').default(''),
  }),

  // CORS
  CORS_ORIGINS: Joi.string().default(
    'http://localhost:3001,http://localhost:3002',
  ),

  // Rate Limiting
  THROTTLE_TTL: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(300),

  // SumUp (optional for development)
  SUMUP_API_KEY: Joi.string().allow('').default(''),
  SUMUP_MERCHANT_CODE: Joi.string().allow('').default(''),
  SUMUP_WEBHOOK_SECRET: Joi.string().allow('').default(''),

  // Storage
  STORAGE_TYPE: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./uploads'),

  // Email (optional for development)
  EMAIL_ENABLED: Joi.boolean().default(false),
  EMAIL_HOST: Joi.string().allow('').default(''),
  EMAIL_PORT: Joi.number().default(587),
  EMAIL_USER: Joi.string().allow('').default(''),
  EMAIL_PASSWORD: Joi.string().allow('').default(''),
  EMAIL_FROM: Joi.string().default('noreply@openeos.de'),

  // Betriebsart: 'saas' (gehostet, mehrmandantenfaehig, kostenpflichtig) oder
  // 'selfhosted' (eigenstaendig, eine Organisation, kostenlos).
  DEPLOYMENT_MODE: Joi.string().valid('saas', 'selfhosted').default('saas'),

  // Event billing (pay-per-event activation)
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  EVENT_PRICE_EUR: Joi.number().default(25),
  FIRST_EVENT_DISCOUNT_PERCENT: Joi.number().min(0).max(100).default(20),
  TEST_EVENT_MAX_ORDERS: Joi.number().default(25),
  OPENREGISTER_API_KEY: Joi.string().allow('').default(''),

  // Empfänger für Support-Nachrichten und Kontaktanfragen (optional)
  SUPPORT_NOTIFY_EMAIL: Joi.string().allow('').default(''),
});
