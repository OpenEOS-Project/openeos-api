import * as Joi from 'joi';

export const validationSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api'),
  API_VERSION: Joi.number().default(1),

  // Database
  DATABASE_HOST: Joi.string().default('localhost'),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USER: Joi.string().default('openeos'),
  DATABASE_PASSWORD: Joi.string().default('openeos_dev_password'),
  DATABASE_NAME: Joi.string().default('openeos'),
  DATABASE_SYNCHRONIZE: Joi.boolean().default(false),
  DATABASE_LOGGING: Joi.boolean().default(true),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_ACCESS_TOKEN_EXPIRATION: Joi.string().default('30m'),
  JWT_REFRESH_TOKEN_EXPIRATION: Joi.string().default('7d'),

  // CORS
  CORS_ORIGINS: Joi.string().default('http://localhost:3001,http://localhost:3002'),

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
});
