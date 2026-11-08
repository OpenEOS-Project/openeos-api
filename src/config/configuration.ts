import { legalConfigFromEnv } from './legal.config';

export type DeploymentMode = 'saas' | 'selfhosted';

const DEPLOYMENT_MODE: DeploymentMode =
  process.env.DEPLOYMENT_MODE === 'selfhosted' ? 'selfhosted' : 'saas';

const IS_SELF_HOSTED = DEPLOYMENT_MODE === 'selfhosted';

export default () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api',
  apiVersion: parseInt(process.env.API_VERSION || '1', 10),
  // Reverse proxies whose X-Forwarded-For is trusted — see trust-proxy.util.ts.
  trustProxy: process.env.TRUST_PROXY,

  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'openeos',
    password: process.env.DATABASE_PASSWORD || 'openeos_dev_password',
    database: process.env.DATABASE_NAME || 'openeos',
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  jwt: {
    secret:
      process.env.JWT_SECRET ||
      'your-super-secret-jwt-key-change-in-production',
    accessTokenExpiration: process.env.JWT_ACCESS_TOKEN_EXPIRATION || '30m',
    refreshTokenExpiration: process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d',
  },

  cors: {
    origins: (
      process.env.CORS_ORIGINS || 'http://localhost:3001,http://localhost:3002'
    ).split(','),
  },

  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL || '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || '300', 10),
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  sumup: {
    apiKey: process.env.SUMUP_API_KEY || '',
    merchantCode: process.env.SUMUP_MERCHANT_CODE || '',
    webhookSecret: process.env.SUMUP_WEBHOOK_SECRET || '',
  },

  storage: {
    type: process.env.STORAGE_TYPE || 'local',
    localPath: process.env.STORAGE_LOCAL_PATH || './uploads',
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    host: process.env.EMAIL_HOST || '',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    user: process.env.EMAIL_USER || '',
    password: process.env.EMAIL_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'noreply@openeos.de',
    // Absendername. Konfigurierbar, damit Testsysteme als solche erkennbar
    // sind — sonst sieht eine Mail von Staging aus wie eine echte.
    fromName: process.env.EMAIL_FROM_NAME || 'OpenEOS',
    // Where "new registration" notifications go. Falls back to ADMIN_EMAIL
    // (already used for seeding) so a single env var can cover both.
    adminNotifyEmail:
      process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || '',
  },

  deployment: {
    // 'saas'       — die gehostete Mehrmandanten-Installation (Standard).
    // 'selfhosted' — eine eigenstaendige Installation: kostenlos, genau eine
    //                Organisation, keine Abrechnung, kein Stripe.
    //
    // Der Standard ist bewusst 'saas': eine bestehende Installation ohne
    // gesetzte Variable verhaelt sich unveraendert.
    mode: DEPLOYMENT_MODE,
    billingEnabled: !IS_SELF_HOSTED,
    multiTenant: !IS_SELF_HOSTED,
  },

  platform: {
    // Impressum und Datenschutz des Plattformbetreibers. Shop und
    // Helferseiten zeigen sie klein unter den Angaben des Vereins
    // ("Bereitgestellt mit OpenEOS"). Gehostet sind das die Seiten von
    // Website der Rechtstexte (LEGAL_SITE_URL bzw. aus APP_URL abgeleitet:
    // openeos.de, auf Staging staging.openeos.de); eigenstaendig betrieben
    // gibt es ohne gesetzte Variable keine Plattform-Links, dann zaehlen
    // nur die Angaben des Vereins. Eine leer gesetzte Variable blendet den
    // Link ebenfalls aus.
    imprintUrl:
      process.env.PLATFORM_IMPRINT_URL ??
      (IS_SELF_HOSTED
        ? ''
        : `${legalConfigFromEnv(process.env, false).siteUrl}/impressum`),
    privacyUrl:
      process.env.PLATFORM_PRIVACY_URL ??
      (IS_SELF_HOSTED
        ? ''
        : `${legalConfigFromEnv(process.env, false).siteUrl}/datenschutz`),
  },

  // AGB, AVV, Datenschutzerklaerung und Impressum von LUXCODE: aktuelle
  // Fassungen und Website (siehe legal.config.ts). Eigenstaendig betrieben
  // gelten sie nicht (keine Annahme, keine erneute Annahme).
  legal: legalConfigFromEnv(process.env, IS_SELF_HOSTED),

  billing: {
    // Zahlungsziel der Stripe-Rechnung beim Kauf auf Rechnung, in Tagen.
    // Eine Organisation kann ein eigenes haben (invoice_days_until_due).
    invoiceDaysUntilDue: parseInt(
      process.env.STRIPE_INVOICE_DAYS_UNTIL_DUE || '14',
      10,
    ),
    // Preis je Veranstaltungstag. Eine mehrtaegige Veranstaltung kostet
    // entsprechend ein Vielfaches davon.
    eventPriceEur: parseFloat(process.env.EVENT_PRICE_EUR || '25'),
    // Tageswechsel fuer die Abrechnung, Stunde in der Zeitzone der
    // Organisation: ein Veranstaltungstag laeuft von 6 bis 6 Uhr, eine Nacht
    // bis 2 Uhr zaehlt noch zum Vortag. Siehe countBillableDays.
    businessDayStartHour: parseInt(
      process.env.BUSINESS_DAY_START_HOUR || '6',
      10,
    ),
    // Nachlass auf die erste abgerechnete Veranstaltung einer Organisation.
    firstEventDiscountPercent: parseFloat(
      process.env.FIRST_EVENT_DISCOUNT_PERCENT || '20',
    ),
    // Cloud-TSE-Zuschlag je Veranstaltung (nicht je Tag) fuer Freischaltungen
    // in Deutschland mit Cloud-TSE. 0 = inklusive: dann erscheint nirgends
    // eine eigene Position.
    tseEventSurchargeEur: Math.max(
      0,
      parseFloat(process.env.TSE_EVENT_SURCHARGE_EUR || '0') || 0,
    ),
    // Im Self-Hosted-Betrieb gibt es keinen Testmodus-Deckel: die Begrenzung
    // existiert nur, um die bezahlte Freischaltung durchzusetzen, und die gibt
    // es dort nicht. Hier statt an den drei Pruefstellen zu entscheiden — alle
    // lesen denselben Wert, damit bleibt die Sonderregel an einer Stelle.
    testEventMaxOrders: IS_SELF_HOSTED
      ? Number.MAX_SAFE_INTEGER
      : parseInt(process.env.TEST_EVENT_MAX_ORDERS || '25', 10),
    openRegisterApiKey: process.env.OPENREGISTER_API_KEY || '',
  },

  // Phasen einer Veranstaltung (Geplant – Aktiv – Beendet), siehe
  // event-phase.util.ts. Echte Verkaeufe beginnen EVENT_EARLY_START_HOURS
  // vor dem ersten Geschaeftstag (je Veranstaltung bis
  // EVENT_EARLY_START_MAX_HOURS einstellbar) und enden EVENT_GRACE_HOURS
  // nach dem letzten. Vorher bucht die Kasse Testbestellungen (hoechstens
  // EVENT_PLANNED_TEST_MAX_ORDERS; eigene Installation: unbegrenzt),
  // danach nimmt sie keine neuen Bestellungen mehr an.
  // EVENT_DATE_PHASES=false: wie frueher zaehlt nur der Status.
  eventPhases: {
    enabled: process.env.EVENT_DATE_PHASES !== 'false',
    earlyStartHours: parseFloat(process.env.EVENT_EARLY_START_HOURS || '12'),
    maxEarlyStartHours: parseFloat(
      process.env.EVENT_EARLY_START_MAX_HOURS || '24',
    ),
    graceHours: parseFloat(process.env.EVENT_GRACE_HOURS || '6'),
    plannedTestMaxOrders: IS_SELF_HOSTED
      ? Number.MAX_SAFE_INTEGER
      : parseInt(process.env.EVENT_PLANNED_TEST_MAX_ORDERS || '200', 10),
  },

  ai: {
    // 'none' (Standard): alle Assistent-Endpunkte antworten 404 AI_DISABLED.
    // Self-Hoster bringen ihren eigenen Schluessel mit oder lassen es aus.
    provider: (process.env.AI_PROVIDER || 'none') as
      | 'anthropic'
      | 'openai'
      | 'none',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    // Modell-IDs liegen in der Konfiguration, nicht im Code. Ohne Angabe
    // gilt je Anbieter ein Standard (siehe ai-provider.factory.ts).
    modelExtract: process.env.AI_MODEL_EXTRACT || '',
    modelClassify: process.env.AI_MODEL_CLASSIFY || '',
    // Kontingente je Organisation und Kalendertag (Europe/Berlin).
    menuImportsPerDay: parseInt(process.env.AI_MENU_IMPORTS_PER_DAY || '5', 10),
    menuPagesPerImport: parseInt(
      process.env.AI_MENU_PAGES_PER_IMPORT || '6',
      10,
    ),
    classifyPerDay: parseInt(process.env.AI_CLASSIFY_PER_DAY || '500', 10),
    maxUploadMb: parseInt(process.env.AI_MAX_UPLOAD_MB || '10', 10),
    // Nur AI_PROVIDER=openai: `reasoning_effort` je Zweck (leer: nicht
    // senden, der Dienst entscheidet). Fuer Qwen3.8-27B auf IONOS:
    // Extraktion `medium`, Klassifikation `none` (sonst frisst das
    // Nachdenken das Token-Limit der Icon-Vorschlaege).
    reasoningEffortExtract: process.env.AI_REASONING_EFFORT_EXTRACT || '',
    reasoningEffortClassify: process.env.AI_REASONING_EFFORT_CLASSIFY || '',
    // Hoechstens so viele Bilder je Modellaufruf (0/leer: unbegrenzt).
    // Mehr Seiten wertet der Import in mehreren Aufrufen aus.
    maxImagesPerRequest: parseInt(
      process.env.AI_MAX_IMAGES_PER_REQUEST || '0',
      10,
    ),
  },

  support: {
    // Eigene Adresse fuer Support-Nachrichten und Kontaktanfragen. Leer:
    // es gilt die allgemeine Admin-Adresse (siehe PlatformSettingsService).
    notifyEmail: process.env.SUPPORT_NOTIFY_EMAIL || '',
  },

  limits: {
    // Missbrauchsschranken (Entscheidung 2026-10-30, gehosteter Betrieb).
    // 0 = unbegrenzt. Je Benutzer bzw. Organisation kann ein Super-Admin
    // einen eigenen Wert hinterlegen (users.organization_limit,
    // organizations.member_limit); Self-Hoster setzen hier ihre Vorgabe.
    organizationsPerUser: parseInt(
      process.env.ORGANIZATIONS_PER_USER_LIMIT || '5',
      10,
    ),
    // Zaehlt aktive Mitglieder plus offene Einladungen.
    membersPerOrganization: parseInt(
      process.env.MEMBERS_PER_ORGANIZATION_LIMIT || '10',
      10,
    ),
  },
});
