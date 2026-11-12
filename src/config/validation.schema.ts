import * as Joi from 'joi';
import { AI_REASONING_EFFORTS } from '../modules/ai/ai-provider.interface';

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
  // Optional: internal token for GET /health/detailed (header X-Health-Token).
  HEALTH_DETAILS_TOKEN: Joi.string().min(24).allow('').optional(),
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
  // Zugangsdaten der Zahlungsanbieter (SumUp) in den
  // Organisationseinstellungen. Leer: TWO_FACTOR_ENCRYPTION_KEY.
  INTEGRATION_ENCRYPTION_KEY: Joi.string().allow(''),
  // Pepper fuer die PIN-Pruefwerte der Kasse (Mitglieder und Bedienungen,
  // HMAC-SHA256). Empfohlen in Produktion (openssl rand -base64 32). Leer:
  // abgeleitet aus TWO_FACTOR_ENCRYPTION_KEY, der Start warnt. Ein Wechsel
  // macht alle PINs ungueltig (neu vergeben).
  PIN_PEPPER: Joi.string().allow('').min(16),

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

  // Impressum/Datenschutz des Plattformbetreibers auf Shop und Helferseiten.
  // Ohne Standardwert: nicht gesetzt heisst "Vorgabe der Betriebsart", leer
  // heisst "keinen Link anzeigen" (siehe configuration.ts).
  PLATFORM_IMPRINT_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  PLATFORM_PRIVACY_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  // Kontaktstelle (Art. 11/12 DSA) und Formular „Inhalt melden“ (Art. 16
  // DSA); leer = nicht anzeigen. Standard siehe configuration.ts.
  PLATFORM_CONTACT_EMAIL: Joi.string().email().allow(''),
  PLATFORM_REPORT_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),

  // Rechtstexte von LUXCODE: Website mit den Fassungen (Standard: aus
  // APP_URL abgeleitet, sonst https://openeos.de) und die aktuellen
  // Fassungen als Datum der „Stand“-Zeile (YYYY-MM-DD).
  LEGAL_SITE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  LEGAL_AGB_VERSION: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(''),
  LEGAL_AVV_VERSION: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(''),
  LEGAL_PRIVACY_VERSION: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(''),
  LEGAL_IMPRINT_VERSION: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(''),
  // Anlage 1 zu den AGB (Leistungsbeschreibung und Preisliste).
  LEGAL_ANLAGE1_VERSION: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .allow(''),
  // `true`: Admins nach einer neuen AGB-/AVV-Fassung blockierend erneut
  // fragen. Standard aus (siehe legal.config.ts).
  LEGAL_REACCEPTANCE_ENABLED: Joi.string()
    .valid('true', 'false', '')
    .insensitive()
    .default('false'),

  // Hersteller auf der Herstellerbescheinigung (Adresszeilen mit |).
  OPERATOR_NAME: Joi.string().allow(''),
  OPERATOR_ADDRESS: Joi.string().allow(''),
  OPERATOR_EMAIL: Joi.string().allow(''),
  // Notfall-Support am Veranstaltungstag (AGB 18.2). Leer: keine Nummer.
  OPERATOR_EMERGENCY_PHONE: Joi.string()
    .pattern(/^\+?[0-9][0-9 ()/-]{4,30}$/)
    .allow(''),

  // Event billing (pay-per-event activation)
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  EVENT_PRICE_EUR: Joi.number().default(25),
  // Stunde, zu der ein abgerechneter Veranstaltungstag wechselt (Ortszeit).
  // 0 ist ausgeschlossen, siehe normalizeBusinessDayStartHour.
  BUSINESS_DAY_START_HOUR: Joi.number().integer().min(1).max(23).default(6),
  FIRST_EVENT_DISCOUNT_PERCENT: Joi.number().min(0).max(100).default(20),
  // Cloud-TSE-Zuschlag je Veranstaltung (DE mit TSE); 0 = inklusive.
  TSE_EVENT_SURCHARGE_EUR: Joi.number().min(0).default(0),
  TEST_EVENT_MAX_ORDERS: Joi.number().default(25),
  // Phasen einer Veranstaltung (Geplant – Aktiv – Beendet). Die Kulanz
  // bleibt unter 14 Stunden: sie endet so vor der monatlichen Abmeldung der
  // Cloud-TSE (Monatsletzter 20 Uhr), auch nach einem Fest bis 6 Uhr.
  EVENT_DATE_PHASES: Joi.string().valid('true', 'false').default('true'),
  EVENT_EARLY_START_HOURS: Joi.number().min(0).max(48).default(12),
  EVENT_EARLY_START_MAX_HOURS: Joi.number().min(0).max(48).default(24),
  EVENT_GRACE_HOURS: Joi.number().min(0).max(13).default(6),
  EVENT_PLANNED_TEST_MAX_ORDERS: Joi.number().integer().min(0).default(200),
  OPENREGISTER_API_KEY: Joi.string().allow('').default(''),

  // Assistent (KI): Anbieter und Kontingente, siehe README „Assistent“.
  AI_PROVIDER: Joi.string()
    .valid('anthropic', 'openai', 'none')
    .default('none'),
  ANTHROPIC_API_KEY: Joi.string().allow('').default(''),
  OPENAI_API_KEY: Joi.string().allow('').default(''),
  // Leer (z. B. `${OPENAI_BASE_URL:-}` in docker-compose) gilt wie nicht
  // gesetzt: configuration.ts faellt auf den Standard zurueck.
  OPENAI_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .default('https://api.openai.com/v1'),
  AI_MODEL_EXTRACT: Joi.string().allow('').default(''),
  AI_MODEL_CLASSIFY: Joi.string().allow('').default(''),
  AI_MENU_IMPORTS_PER_DAY: Joi.number().integer().min(0).default(5),
  AI_MENU_PAGES_PER_IMPORT: Joi.number().integer().min(1).max(20).default(6),
  AI_CLASSIFY_PER_DAY: Joi.number().integer().min(0).default(500),
  AI_MAX_UPLOAD_MB: Joi.number().integer().min(1).max(50).default(10),
  // Nur AI_PROVIDER=openai; leer = `reasoning_effort` nicht senden.
  AI_REASONING_EFFORT_EXTRACT: Joi.string()
    .valid(...AI_REASONING_EFFORTS)
    .empty('')
    .default(''),
  AI_REASONING_EFFORT_CLASSIFY: Joi.string()
    .valid(...AI_REASONING_EFFORTS)
    .empty('')
    .default(''),
  // 0 = unbegrenzt; leer (`${AI_MAX_IMAGES_PER_REQUEST:-}`) gilt wie 0.
  AI_MAX_IMAGES_PER_REQUEST: Joi.number()
    .integer()
    .min(0)
    .max(100)
    .empty('')
    .default(0),

  // Cloud-TSE (tse-swissbit-plan.md §8, README „Cloud-TSE“). Leere Werte
  // (z. B. `${SWISSBIT_BASE_URL:-}` in docker-compose) gelten wie nicht
  // gesetzt.
  TSE_PROVIDER: Joi.string().valid('none', 'swissbit', '').default('none'),
  // `true`: ohne eingerichteten Provider zeigt die gehostete Installation
  // die Cloud-TSE als „Bald verfuegbar“ (GET /organizations/:id/tse →
  // `availability: 'coming_soon'`). Eigene Installationen ignorieren es.
  TSE_COMING_SOON: Joi.string()
    .valid('true', 'false', '')
    .insensitive()
    .default('false'),
  // `monthly` (Standard): Abmeldung zum Monatsende; `per_event` = alter
  // Name dafuer; `persistent`: TSE bleibt aktiv.
  TSE_LIFECYCLE: Joi.string()
    .valid('monthly', 'persistent', 'per_event', '')
    .default('monthly'),
  SWISSBIT_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(''),
  SWISSBIT_VENDOR_CLIENT: Joi.string().allow(''),
  SWISSBIT_VENDOR_SECRET: Joi.string().allow(''),
  SWISSBIT_CREDIT_CLIENT_ID: Joi.string().allow(''),
  SWISSBIT_CREDIT_CLIENT_SECRET: Joi.string().allow(''),
  SWISSBIT_PRODUCT_TYPE: Joi.string().allow(''),
  TSE_ENCRYPTION_KEY: Joi.string().allow(''),
  TSE_EXPORT_DIR: Joi.string().allow(''),
  // Private Ablage (Speisekarten-Importe, TSE-Exporte, DSFinV-K-Archiv);
  // leer: <UPLOAD_DIR>/../private
  PRIVATE_STORAGE_DIR: Joi.string().allow(''),
  TSE_TX_TIMEOUT_MS: Joi.number().integer().min(500).max(60000).empty(''),
  TSE_SIGN_BUDGET_MS: Joi.number().integer().min(500).max(120000).empty(''),
  TSE_ADMIN_TIMEOUT_MS: Joi.number().integer().min(1000).max(300000).empty(''),

  // Empfänger für Support-Nachrichten und Kontaktanfragen (optional)
  SUPPORT_NOTIFY_EMAIL: Joi.string().allow('').default(''),

  // Missbrauchsschranken: Organisationen je Benutzer und Mitglieder (inkl.
  // offener Einladungen) je Organisation. 0 = unbegrenzt.
  ORGANIZATIONS_PER_USER_LIMIT: Joi.number().integer().min(0).default(5),
  MEMBERS_PER_ORGANIZATION_LIMIT: Joi.number().integer().min(0).default(10),
  // Bedienungen je Organisation (zaehlen nicht zu den Mitgliedern), 0 = unbegrenzt.
  WAITERS_PER_ORGANIZATION_LIMIT: Joi.number().integer().min(0).default(200),

  // Aufbewahrung und Loeschung (README „Aufbewahrung und Löschung“). Leer
  // gilt wie nicht gesetzt; Standardwerte in retention.config.ts. Fristen,
  // nach denen Kundendaten verschwinden, nicht unter 30 Tagen.
  RETENTION_ENABLED: Joi.boolean().empty(''),
  RETENTION_DRY_RUN: Joi.boolean().empty(''),
  RETENTION_CATEGORIES: Joi.string().allow(''),
  RETENTION_CONTACT_EMAIL: Joi.string().email().allow(''),
  RETENTION_GUEST_DATA_DAYS: Joi.number().integer().min(30).empty(''),
  RETENTION_HELPER_DATA_DAYS: Joi.number().integer().min(30).empty(''),
  RETENTION_AUDIT_LOG_DAYS: Joi.number().integer().min(1).empty(''),
  RETENTION_STALE_CREDENTIAL_DAYS: Joi.number().integer().min(1).empty(''),
  RETENTION_SUPPORT_MONTHS: Joi.number().integer().min(1).empty(''),
  RETENTION_CONTACT_MONTHS: Joi.number().integer().min(1).empty(''),
  RETENTION_CONTENT_REPORT_MONTHS: Joi.number().integer().min(1).empty(''),
  RETENTION_INACTIVE_ORG_MONTHS: Joi.number().integer().min(1).empty(''),
  RETENTION_INACTIVE_USER_MONTHS: Joi.number().integer().min(1).empty(''),
  RETENTION_NOTICE_DAYS: Joi.number().integer().min(30).empty(''),
  RETENTION_EXPORT_PERIOD_DAYS: Joi.number().integer().min(30).empty(''),
  RETENTION_FISCAL_ARCHIVE_YEARS: Joi.number().integer().min(10).empty(''),
  RETENTION_RUN_LOG_YEARS: Joi.number().integer().min(1).empty(''),

  // Token fuer GET /api/internal/deploy-guard (Deploy-Workflows fragen dort,
  // ob gerade ein Fest laeuft). Leer: Endpunkt antwortet 404.
  DEPLOY_GUARD_TOKEN: Joi.string().min(32).allow('').optional(),

  // Herunterfahren: wie lange offene Anfragen noch zu Ende laufen duerfen,
  // und optional eine Wartezeit, in der die Instanz schon "nicht bereit"
  // meldet, aber noch bedient (siehe common/lifecycle/shutdown.service.ts).
  SHUTDOWN_TIMEOUT_MS: Joi.number().integer().min(0).optional(),
  SHUTDOWN_DRAIN_DELAY_MS: Joi.number().integer().min(0).optional(),
});
