import {
  DocumentBuilder,
  type OpenAPIObject,
  type SwaggerDocumentOptions,
} from '@nestjs/swagger';

import { API_TOKEN_SECURITY_SCHEME } from '../decorators/api-token-access.decorator';
import {
  ORGANIZATION_TOKEN_SCOPES,
  SCOPE_DESCRIPTIONS,
} from '../../modules/api-tokens/api-scopes';
import { API_TOKEN_LIMITS } from '../guards/api-token-throttler.guard';
import { MAX_ACTIVE_TOKENS_PER_ORGANIZATION } from '../../modules/api-tokens/api-tokens.service';

/** Name des Sicherheitsschemas fuer den Deploy-Guard (shared secret). */
export const DEPLOY_GUARD_SECURITY_SCHEME = 'Deploy-guard-token';

/** Oeffentliche Adresse des gehosteten Angebots. */
export const PUBLIC_API_URL = 'https://api.openeos.de';

/**
 * Reihenfolge und Beschreibung der Tags — so erscheinen sie in Swagger UI
 * und in der Doku-Seite (openeos-docs rendert `docs/openapi.json`).
 * Zuerst, was ein API-Token erreicht; die Sitzungs-, Kassen- und
 * Plattform-Endpunkte folgen.
 */
export const OPENAPI_TAGS: ReadonlyArray<[name: string, description: string]> =
  [
    [
      'API Tokens',
      'API-Tokens einer Organisation ausstellen und widerrufen (nur mit Anmeldung)',
    ],
    ['Organizations', 'Organisation, Mitglieder, Einladungen'],
    ['Events', 'Veranstaltungen anlegen, bearbeiten, freischalten'],
    ['Categories', 'Kategorien je Veranstaltung'],
    ['Products', 'Produkte je Veranstaltung'],
    ['Pfand Types', 'Pfandarten der Organisation'],
    ['Tables', 'Bereiche, Tische und Tischplan'],
    [
      'Production Stations',
      'Produktionsstationen (Küche, Ausgabe) je Veranstaltung',
    ],
    ['Print Templates', 'Bon-Vorlagen'],
    ['Printers', 'Drucker, Drucker-Agenten und erkannte Drucker'],
    ['Shift Plans', 'Schichtpläne, Jobs, Schichten, Helfer-Anmeldungen'],
    ['Reports', 'Berichte und Auswertungen'],
    ['Orders', 'Bestellungen'],
    ['Devices', 'Kassen und Displays: verwalten, koppeln, registrieren'],
    [
      'Assistant',
      'Assistent: Opt-in je Organisation, Speisekarten-Import, Icon-Vorschläge',
    ],
    ['Auth', 'Anmeldung, Registrierung, zweiter Faktor'],
    ['Users', 'Eigenes Profil und Sitzungen'],
    ['Payments', 'Zahlungen und Erstattungen'],
    ['Discount Vouchers', 'Rabattgutscheine'],
    ['Inventory', 'Inventur und Bestandsbewegungen'],
    ['Print Jobs', 'Druckaufträge'],
    ['QR Codes', 'QR-Codes'],
    ['Uploads', 'Dateien hochladen'],
    ['Invoices', 'Rechnungen der Organisation'],
    [
      'Event Billing',
      'Freischaltung und Abrechnung von Veranstaltungen (SaaS)',
    ],
    ['SumUp', 'SumUp-Kartenleser'],
    ['Support', 'Support-Nachrichten'],
    ['Onboarding', 'Einrichtungsstatus'],
    ['Online Orders', 'Öffentliche Online-Bestellung (Session-Token)'],
    ['Shop (Public)', 'Öffentlicher Shop (Vorbestellung)'],
    ['Shop Checkout (Public)', 'Bezahlung im öffentlichen Shop'],
    ['Shifts (Public)', 'Öffentliche Helfer-Anmeldung'],
    ['Device API', 'Kassen- und Display-Geräte (Geräte-Token)'],
    ['Admin', 'Super-Admin (Plattform)'],
    ['Admin Support', 'Super-Admin: Support-Nachrichten'],
    ['Admin — Zuschriften', 'Super-Admin: Kontaktanfragen'],
    ['Monitoring', 'Plattform-Kennzahlen (Super-Admin-Token)'],
    ['Changelog', 'Öffentliches Änderungsprotokoll'],
    ['Contact', 'Kontaktformular'],
    ['Setup', 'Ersteinrichtung (Self-Hosting)'],
    ['Internal', 'Interne Endpunkte (Deploy-Schutz)'],
    ['Health', 'Health-Checks'],
  ];

function scopeList(): string {
  return ORGANIZATION_TOKEN_SCOPES.map(
    (scope) => `| \`${scope}\` | ${SCOPE_DESCRIPTIONS[scope]} |`,
  ).join('\n');
}

function limitList(): string {
  return API_TOKEN_LIMITS.map((grenze) =>
    grenze.ttl <= 60 * 1000
      ? `- ${grenze.limit} Aufrufe je Minute`
      : `- ${grenze.limit} Aufrufe je Tag`,
  ).join('\n');
}

/**
 * Lesbare operationIds statt `EventsController_findAll`: Controller-Name
 * ohne Suffix, dann die Methode (`events_findAll`). Die oeffentlichen
 * Endpunkte setzen in @ApiOperation ohnehin eine sprechende operationId
 * (`listEvents`); das hier ist der Rueckfall fuer alle anderen, damit die
 * Doku-Seite nie einen Klassennamen zeigt.
 */
export function operationIdFactory(
  controllerKey: string,
  methodKey: string,
  version?: string,
): string {
  const controller = controllerKey.replace(/Controller$/, '');
  const resource = controller.charAt(0).toLowerCase() + controller.slice(1);
  const id = resource ? `${resource}_${methodKey}` : methodKey;
  return version ? `${id}_${version}` : id;
}

/** Optionen fuer SwaggerModule.createDocument — Swagger UI und Generator. */
export const OPENAPI_DOCUMENT_OPTIONS: SwaggerDocumentOptions = {
  operationIdFactory,
};

/**
 * Schluss der Einleitung: Die vollstaendige Beschreibung erklaert auch
 * Sitzungen und Geraete; die oeffentliche Referenz sagt, was sie bewusst
 * weglaesst.
 */
function descriptionFooter(variant: 'full' | 'public'): string {
  if (variant === 'public') {
    return `
## Was diese Referenz zeigt

Nur die Endpunkte, die ein API-Token erreichen kann, plus die Verwaltung der Tokens selbst (nur mit Anmeldung). Alle anderen Teile der API — Anmeldung und Sitzungen der Web-App, Kasse und Geräte-API (\`/api/device-api/*\`), Zahlungen, Mitglieder, Abrechnung, Admin — sind absichtlich nicht dokumentiert: Sie sind für die Apps von OpenEOS gedacht und keine stabile Schnittstelle für Integrationen. Wer OpenEOS selbst betreibt, findet die vollständige Beschreibung im Repository (\`docs/openapi.json\`) und außerhalb der Produktion unter \`/docs\`.

Zu jedem Endpunkt steht der nötige Scope (\`x-api-token-scope\`). Die Texte sind auf Deutsch; die Referenz ist für beide Sprachen der Doku-Seite dieselbe.
`;
  }
  return `
## Sitzungen (Web-App)

Die Web-App meldet sich mit E-Mail/Passwort (\`POST /api/auth/login\`) an und erhält ein kurzlebiges Access-Token (JWT, \`Authorization: Bearer\`) sowie ein Refresh-Token als httpOnly-Cookie. Diese Endpunkte sind hier der Vollständigkeit halber dokumentiert; für Integrationen nimm ein API-Token.

## Geräte

Kassen und Displays sprechen \`/api/device-api/*\` mit einem Geräte-Token (\`X-Device-Token\`). Diese Endpunkte sind nicht für Integrationen gedacht.
`;
}

/**
 * Einleitung der API-Beschreibung (Markdown). `full` fuer Swagger UI und
 * docs/openapi.json, `public` fuer docs/openapi.public.json (Doku-Seite).
 */
export function openApiDescription(variant: 'full' | 'public' = 'full'): string {
  return `
OpenEOS ist ein Kassen- und Bestellsystem für Vereinsfeste. Diese Referenz beschreibt die REST-API unter \`${PUBLIC_API_URL}/api\` (selbst gehostet: \`https://<deine-api>/api\`).

## Zugang mit API-Token

Für Skripte, Automatisierungen (z. B. Zapier) und KI-Agenten gibt es **API-Tokens je Organisation**. Dieselben Tokens öffnen den **MCP-Server** unter \`${PUBLIC_API_URL}/mcp\` (Streamable HTTP, außerhalb von \`/api\`) für Claude, Cursor und eigene Agenten — die Werkzeuge dort folgen denselben Scopes. Ein Token wirkt wie die Person, die ihn ausgestellt hat — beschränkt auf eine Organisation, auf die gewählten Scopes und auf die hier mit *API-token* markierten Endpunkte. Alles andere (Kasse, Zahlungen, Mitglieder, Abrechnung, Löschen, Freischaltung) bleibt der Anmeldung in der App vorbehalten.

**Token anlegen:** In der Web-App unter *Einstellungen → Organisation → Zugänge* (Organisations-Admin) oder per \`POST /api/organizations/{organizationId}/api-tokens\` mit einer angemeldeten Sitzung. Der Token (\`oeos_…\`) wird genau einmal angezeigt; gespeichert wird nur ein Hash. Höchstens ${MAX_ACTIVE_TOKENS_PER_ORGANIZATION} aktive Tokens je Organisation.

**Verwenden:** \`Authorization: Bearer oeos_…\` — derselbe Header wie für Sitzungs-JWTs. Welche Organisation gemeint ist, steht im Pfad; ein Token erreicht nur seine eigene (sonst \`403 API_TOKEN_WRONG_ORGANIZATION\`).

### Scopes

| Scope | Erlaubt |
|---|---|
${scopeList()}

Schreib-Scopes schließen \`read\` nicht ein. Jeder Endpunkt nennt den nötigen Scope als \`x-api-token-scope\`; fehlt er am Token, antwortet die API mit \`403 API_TOKEN_SCOPE_MISSING\`, bei nicht freigegebenen Endpunkten mit \`403 API_TOKEN_NOT_ALLOWED\`.

### Grenzen

Je Token:
${limitList()}

Darüber hinaus \`429 API_TOKEN_RATE_LIMITED\` mit \`Retry-After\`. Zusätzlich gilt die allgemeine Grenze je IP-Adresse.

### Fehler

Jede Fehlerantwort hat die Form \`{ "error": { "code", "reason", "message", "params", "details", "requestId", "timestamp" } }\`. \`code\` ist die allgemeine Klasse (\`FORBIDDEN\`, \`NOT_FOUND\`, …), \`reason\` der konkrete Fall (\`API_TOKEN_SCOPE_MISSING\`, \`EVENT_NOT_FOUND\`, …).
${descriptionFooter(variant)}`.trim();
}

/**
 * Die gemeinsame OpenAPI-Konfiguration fuer Swagger UI (Entwicklung) und
 * fuer \`pnpm docs:generate\` (docs/openapi.json, von der Doku-Seite
 * gerendert) — damit beide dasselbe zeigen.
 */
export function buildOpenApiConfig(): Omit<OpenAPIObject, 'paths'> {
  const builder = new DocumentBuilder()
    .setTitle('OpenEOS API')
    .setDescription(openApiDescription())
    .setVersion('1.0')
    .setContact('OpenEOS', 'https://openeos.de', 'info@openeos.de')
    .setLicense(
      'AGPL-3.0-or-later',
      'https://www.gnu.org/licenses/agpl-3.0.html',
    )
    .addServer(PUBLIC_API_URL, 'OpenEOS (gehostet)')
    .addServer('http://localhost:3000', 'Lokale Entwicklung')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'oeos_…',
        description:
          'API-Token der Organisation (Einstellungen → Organisation → Zugänge). ' +
          'Erreicht nur die mit diesem Schema markierten Endpunkte, und ' +
          'nur mit dem jeweils genannten Scope (`x-api-token-scope`).',
      },
      API_TOKEN_SECURITY_SCHEME,
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access-Token einer angemeldeten Sitzung (Web-App)',
      },
      'JWT-auth',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque',
        description:
          'Gemeinsames Geheimnis der Deploy-Workflows (DEPLOY_GUARD_TOKEN), nur für /internal/deploy-guard',
      },
      DEPLOY_GUARD_SECURITY_SCHEME,
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-Organization-Id',
        in: 'header',
        description: 'Organisation, falls nicht im Pfad',
      },
      'X-Organization-Id',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-Session-Token',
        in: 'header',
        description: 'Session-Token der Online-Bestellung',
      },
      'X-Session-Token',
    );

  for (const [name, description] of OPENAPI_TAGS) {
    builder.addTag(name, description);
  }

  return builder.build();
}
