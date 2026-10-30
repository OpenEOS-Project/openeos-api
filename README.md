# OpenEOS API

Backend-Server für OpenEOS mit REST API, WebSocket und Authentifizierung.

## Features

- REST API für alle CRUD-Operationen
- WebSocket für Echtzeit-Kommunikation (Socket.io)
- JWT-basierte Authentifizierung mit Refresh Tokens
- Multi-Tenant Architektur
- Workflow Engine
- Rate Limiting
- Health Checks für Kubernetes
- Swagger/OpenAPI Dokumentation

## Tech Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** NestJS 10.x
- **Sprache:** TypeScript 5.x (strict mode)
- **ORM:** TypeORM 0.3.x
- **Datenbank:** PostgreSQL 16
- **Cache:** Redis 7
- **WebSocket:** Socket.io 4.x
- **Auth:** JWT + Passport.js

## Setup

### Voraussetzungen

- Node.js 20 LTS
- pnpm 8+
- Docker & Docker Compose

### Installation

```bash
# Dependencies installieren
pnpm install

# Umgebungsvariablen kopieren
cp .env.example .env

# Datenbank und Redis starten
docker-compose up -d

# Migrations ausführen
pnpm migration:run

# Development Server starten
pnpm dev
```

### Verfügbare Befehle

```bash
# Development
pnpm dev              # Development Server mit Hot Reload
pnpm start            # Production Server
pnpm build            # Production Build

# Database
pnpm migration:generate  # Neue Migration generieren
pnpm migration:run       # Migrations ausführen
pnpm migration:revert    # Letzte Migration zurücksetzen
pnpm seed                # Seed-Daten einfügen

# Testing
pnpm test             # Unit Tests
pnpm test:e2e         # E2E Tests
pnpm test:cov         # Test Coverage

# Linting
pnpm lint             # ESLint
pnpm format           # Prettier
```

## API Dokumentation

### Swagger UI

Im Development-Modus (`NODE_ENV` ≠ `production`) ist die interaktive API-Dokumentation verfügbar unter:

```
http://localhost:3000/docs
```

(Rohe Spezifikation: `/docs-json`, `/docs-yaml`.) In Produktion wird `/docs` nicht ausgeliefert; die öffentliche API-Referenz rendert die Doku-Seite (openeos-docs) aus der eingecheckten Spezifikation `docs/openapi.json` / `docs/openapi.yaml`.

Beide entstehen aus derselben Konfiguration wie Swagger UI (`src/common/openapi/openapi-config.ts`, Einleitung, Sicherheitsschemata, Tag-Reihenfolge):

```bash
pnpm docs:generate   # schreibt docs/openapi.json und docs/openapi.yaml
pnpm docs:check      # Exit 1, wenn die eingecheckte Fassung nicht zum Code passt (läuft in CI)
```

Beide brauchen eine erreichbare Datenbank und Redis (`docker compose up -d postgres redis`), weil `AppModule` beim Start verbindet. Nach jeder Änderung an Controllern oder DTOs: `pnpm docs:generate` und das Ergebnis mit committen.

### API-Zugänge (API-Tokens)

Für Skripte, Automatisierungen und KI-Agenten (MCP) gibt es API-Tokens je Organisation (Details und Matrix: `ki-plan.md`, Abschnitt 8).

- **Anlegen:** `POST /api/organizations/:organizationId/api-tokens` `{ name, scopes[], expiresAt? }` — nur Organisations-Admins, nur mit Anmeldung (JWT). Antwort enthält `token` (`oeos_…`) genau einmal; gespeichert wird nur der SHA-256-Hash. Höchstens 20 aktive Tokens je Organisation. `GET …/api-tokens` listet (ohne Geheimnis), `DELETE …/api-tokens/:id` widerruft. Beides schreibt ins Audit-Log (`api_token_created`, `api_token_revoked`).
- **Verwenden:** `Authorization: Bearer oeos_…` — derselbe Header wie für Sitzungs-JWTs; der `JwtAuthGuard` erkennt Tokens am Präfix.
- **Scopes** (`TokenScope` in `src/modules/api-tokens/api-scopes.ts`): `read`, `catalog:write`, `events:write`, `tables:write`, `staff:write`, `devices:write`, `settings:write`. Schreib-Scopes schließen `read` nicht ein. Super-Admin-Tokens (`/api/admin/api-tokens`) tragen nur `monitoring:read`.
- **Regeln im Guard:** Ein Token wirkt wie sein Besitzer (Rolle und Modul-Berechtigungen gelten weiter), aber nur in seiner Organisation (`403 API_TOKEN_WRONG_ORGANIZATION`), nur an Endpunkten mit `@ApiTokenAccess(scope)` (`403 API_TOKEN_NOT_ALLOWED`) und nur mit passendem Scope (`403 API_TOKEN_SCOPE_MISSING`). Verlässt der Besitzer die Organisation, ist der Token wertlos (`401 API_TOKEN_INVALID`). Es gibt keine Freigaben für Kasse, Zahlungen, Mitglieder, Abrechnung, Löschen oder Freischaltung — `api-token-allowlist.spec.ts` prüft das und hält die Matrix als Snapshot.
- **Rate-Limit je Token:** 120 Aufrufe/min, 5 000/Tag (`ApiTokenThrottlerGuard`, Zähler je Instanz; `429 API_TOKEN_RATE_LIMITED`).
- **Neuen Endpunkt freigeben:** `@ApiTokenAccess(TokenScope.…)` an den Handler; der Decorator trägt zugleich das Sicherheitsschema und `x-api-token-scope` in die OpenAPI-Beschreibung ein. Danach `pnpm docs:generate` und den Snapshot aktualisieren.

### Projektstruktur

```
src/
├── main.ts                     # Bootstrap
├── app.module.ts               # Root Module
├── config/                     # Konfiguration
├── common/                     # Shared Code (Guards, Filters, etc.)
├── database/
│   ├── entities/               # TypeORM Entities
│   ├── migrations/             # Database Migrations
│   └── seeds/                  # Seed Data
└── modules/
    ├── auth/                   # Authentifizierung
    ├── organizations/          # Multi-Tenant
    ├── events/                 # Veranstaltungen
    ├── categories/             # Kategorien
    ├── products/               # Produkte
    ├── orders/                 # Bestellungen
    ├── payments/               # Zahlungen
    ├── devices/                # Geräte
    ├── printers/               # Drucker
    ├── print-templates/        # Druckvorlagen
    ├── print-jobs/             # Druckaufträge
    ├── gateway/                # WebSocket Gateway
    ├── workflows/              # Workflow Engine
    ├── qr-codes/               # QR-Code Verwaltung
    ├── online-orders/          # Online-Bestellungen
    ├── credits/                # Guthaben-System
    ├── invoices/               # Rechnungen
    ├── admin/                  # Super-Admin
    ├── reports/                # Berichte
    ├── uploads/                # Datei-Uploads
    ├── inventory/              # Inventur
    └── health/                 # Health Checks
```

## Implementierte Module

### Auth (`/api/auth`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| POST | `/register` | Benutzer registrieren |
| POST | `/login` | Anmelden (JWT + Refresh Token) |
| POST | `/refresh` | Token erneuern |
| POST | `/logout` | Abmelden |
| POST | `/forgot-password` | Passwort vergessen |
| POST | `/reset-password` | Passwort zurücksetzen |
| PATCH | `/change-password` | Passwort ändern |
| GET | `/me` | Aktueller Benutzer |

### Organizations (`/api/organizations`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Organisationen des Benutzers |
| POST | `/` | Organisation erstellen |
| GET | `/:id` | Organisation abrufen |
| PATCH | `/:id` | Organisation aktualisieren |
| DELETE | `/:id` | Organisation löschen |
| GET | `/:id/members` | Mitglieder abrufen |
| POST | `/:id/members` | Mitglied hinzufügen |
| PATCH | `/:id/members/:userId` | Mitglied aktualisieren |
| DELETE | `/:id/members/:userId` | Mitglied entfernen |
| POST | `/:id/invitations` | Einladung erstellen |
| GET | `/invitations/:token` | Einladung abrufen (public) |
| POST | `/invitations/:token/accept` | Einladung annehmen (public) |

### Events (`/api/organizations/:orgId/events`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Events |
| POST | `/` | Event erstellen |
| GET | `/:id` | Event abrufen |
| PATCH | `/:id` | Event aktualisieren |
| DELETE | `/:id` | Event löschen |
| POST | `/:id/activate` | Event aktivieren (Credit-Check) |
| POST | `/:id/complete` | Event abschließen |
| POST | `/:id/cancel` | Event abbrechen |

### Categories (`/api/organizations/:orgId/categories`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Kategorien |
| POST | `/` | Kategorie erstellen |
| GET | `/:id` | Kategorie abrufen |
| PATCH | `/:id` | Kategorie aktualisieren |
| DELETE | `/:id` | Kategorie löschen |
| PATCH | `/reorder` | Kategorien sortieren |

### Products (`/api/organizations/:orgId/products`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Produkte |
| POST | `/` | Produkt erstellen |
| GET | `/:id` | Produkt abrufen |
| PATCH | `/:id` | Produkt aktualisieren |
| DELETE | `/:id` | Produkt löschen |
| PATCH | `/:id/availability` | Verfügbarkeit umschalten |
| GET | `/:id/stock` | Bestand abrufen |
| PATCH | `/:id/stock` | Bestand setzen |
| POST | `/:id/stock/adjust` | Bestand anpassen |
| GET | `/low-stock` | Produkte mit niedrigem Bestand |
| PATCH | `/reorder` | Produkte sortieren |

### Orders (`/api/organizations/:orgId/orders`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Bestellungen |
| POST | `/` | Bestellung erstellen |
| GET | `/:id` | Bestellung abrufen |
| PATCH | `/:id` | Bestellung aktualisieren |
| DELETE | `/:id` | Bestellung löschen |
| POST | `/:id/items` | Artikel hinzufügen |
| PATCH | `/:id/items/:itemId` | Artikel aktualisieren |
| DELETE | `/:id/items/:itemId` | Artikel entfernen |
| POST | `/:id/items/:itemId/ready` | Artikel als fertig markieren |
| POST | `/:id/items/:itemId/deliver` | Artikel als geliefert markieren |
| POST | `/:id/complete` | Bestellung abschließen |
| POST | `/:id/cancel` | Bestellung stornieren |

### Payments (`/api/organizations/:orgId/payments`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Zahlungen |
| POST | `/` | Zahlung erstellen |
| GET | `/:id` | Zahlung abrufen |
| GET | `/order/:orderId` | Zahlungen einer Bestellung |
| POST | `/split` | Split-Payment |
| POST | `/:id/refund` | Rückerstattung |

### Devices (`/api/organizations/:orgId/devices`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Geräte |
| POST | `/` | Gerät erstellen |
| GET | `/:id` | Gerät abrufen |
| PATCH | `/:id` | Gerät aktualisieren |
| DELETE | `/:id` | Gerät löschen |
| POST | `/:id/authenticate` | Gerät authentifizieren |
| POST | `/:id/regenerate-token` | Token regenerieren |

### Printers (`/api/organizations/:orgId/printers`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Drucker |
| POST | `/` | Netzwerkdrucker manuell anlegen (`deviceId`, `connectionConfig.ipAddress`/`port`) |
| GET | `/:id` | Drucker abrufen |
| PATCH | `/:id` | Name, Typ, Papierbreite, Kassenlade, `isActive`; bei `network` auch IP/Port |
| DELETE | `/:id` | Drucker löschen (Zuordnungen in Stationen, Bon-Workflow, Geräten werden gelöst) |
| POST | `/:id/test` | Testdruck |

### Printer Agents (`/api/organizations/:orgId/printer-agents`)

Ein Drucker-Agent ist ein Gerät vom Typ `printer_agent` (Pairing wie bei
Kassen über `POST /devices/init` + `POST /devices/link`). Er findet USB-,
Netzwerk- und Windows-Drucker selbst und meldet sie; übernommen werden sie
in der Web-App.

| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Agents mit Online-Status, `agentInfo`, Anzahl gefundener/übernommener Drucker |
| DELETE | `/:deviceId` | Agent samt Druckern entfernen |
| POST | `/:deviceId/discover` | Neu suchen (`{ subnetScan?: boolean }`), 409 `PRINTER_AGENT_OFFLINE` wenn nicht verbunden |
| GET | `/:deviceId/discovered` | Gefundene Drucker (mit `printerId`, `lastSeenAt`) |
| POST | `/:deviceId/discovered/:id/adopt` | Übernehmen (`name`, `type`, `paperWidth`, `hasCashDrawer`), 409 `PRINTER_ALREADY_ADOPTED` |

Agent-Seite (`/api/device-api`, Header `X-Device-Token`): `POST /printers/discovered`
(`{ printers: DiscoveredPrinterInput[], full: boolean }`, Upsert je
`fingerprint`), `GET /printers` (nur übernommene Drucker), `POST /printers/sync`
antwortet mit **410** `PRINTER_SYNC_REMOVED`. Socket: `agentHeartbeat`
(Agent → Server, alle 30 s) und `printerDiscover` (Server → Agent).

### Print Templates (`/api/organizations/:orgId/print-templates`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Vorlagen |
| POST | `/` | Vorlage erstellen |
| GET | `/:id` | Vorlage abrufen |
| PATCH | `/:id` | Vorlage aktualisieren |
| DELETE | `/:id` | Vorlage löschen |
| POST | `/:id/preview` | Vorschau |

### Print Jobs (`/api/organizations/:orgId/print-jobs`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Druckaufträge |
| GET | `/:id` | Druckauftrag abrufen |
| POST | `/:id/retry` | Erneut drucken |
| POST | `/:id/cancel` | Abbrechen |

### Workflows (`/api/organizations/:orgId/workflows`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Workflows |
| POST | `/` | Workflow erstellen |
| GET | `/:id` | Workflow abrufen |
| PATCH | `/:id` | Workflow aktualisieren |
| DELETE | `/:id` | Workflow löschen |
| POST | `/:id/activate` | Workflow aktivieren |
| POST | `/:id/deactivate` | Workflow deaktivieren |
| POST | `/:id/test` | Workflow testen |
| GET | `/:id/runs` | Workflow-Ausführungen |

### QR Codes (`/api/organizations/:orgId/qr-codes`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle QR-Codes |
| POST | `/` | QR-Code erstellen |
| GET | `/:id` | QR-Code abrufen |
| PATCH | `/:id` | QR-Code aktualisieren |
| DELETE | `/:id` | QR-Code löschen |
| GET | `/:id/image` | QR-Code Bild (PNG/SVG) |
| POST | `/bulk` | Mehrere QR-Codes erstellen |

### Online Orders (`/api/public/order`) - Öffentlich
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| POST | `/session` | Session starten (QR-Code) |
| GET | `/session` | Session abrufen |
| GET | `/menu` | Menü abrufen |
| POST | `/cart` | Artikel zum Warenkorb |
| PATCH | `/cart/:index` | Warenkorb-Artikel aktualisieren |
| DELETE | `/cart` | Warenkorb leeren |
| POST | `/submit` | Bestellung abschicken |
| GET | `/status` | Bestellstatus |

### Credits (`/api/organizations/:orgId/credits`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Guthaben abrufen |
| GET | `/packages` | Verfügbare Pakete |
| GET | `/packages/:slug` | Paket abrufen |
| POST | `/purchase` | Guthaben kaufen |
| GET | `/history` | Kaufhistorie |
| GET | `/licenses` | Lizenz-Nutzung |

### Invoices (`/api/organizations/:orgId/invoices`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Rechnungen |
| GET | `/:id` | Rechnung abrufen |
| GET | `/:id/pdf` | Rechnung als PDF |

### Reports (`/api/organizations/:orgId/reports`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/sales` | Verkaufsbericht |
| GET | `/products` | Produktbericht |
| GET | `/payments` | Zahlungsbericht |
| GET | `/hourly` | Stundenbericht |
| GET | `/inventory` | Bestandsbericht |
| GET | `/stock-movements` | Lagerbewegungen |
| GET | `/export` | Export (CSV/JSON) |

### Uploads (`/api/organizations/:orgId/uploads`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| POST | `/image` | Bild hochladen |
| DELETE | `/:filename` | Bild löschen |
| GET | `/:category/:filename` | Bild abrufen |

Alle Dateien (auch die des Speisekarten-Imports) liegen unter `UPLOAD_DIR` (im Container `/app/uploads`). Das Image legt das Verzeichnis für den Nutzer `nestjs` (uid 1001) an; ein **Bind-Mount vom Host überstimmt das**: gehört das Host-Verzeichnis root, antworten Uploads mit `503 UPLOAD_DIR_NOT_WRITABLE` („Der Upload-Ordner auf dem Server ist nicht beschreibbar – bitte den Betreiber informieren.“) und der Start warnt im Log. Abhilfe auf dem Host: `chown -R 1001 <verzeichnis>`. Ein benanntes Volume (wie in `docker-compose.prod.yml`) übernimmt die Rechte aus dem Image und braucht nichts weiter.

### Inventory (`/api/organizations/:orgId/inventory`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/counts` | Alle Inventuren |
| POST | `/counts` | Inventur erstellen |
| GET | `/counts/:id` | Inventur abrufen |
| PATCH | `/counts/:id` | Inventur aktualisieren |
| DELETE | `/counts/:id` | Inventur löschen |
| POST | `/counts/:id/start` | Inventur starten |
| POST | `/counts/:id/complete` | Inventur abschließen |
| POST | `/counts/:id/cancel` | Inventur abbrechen |
| POST | `/counts/:id/items` | Artikel hinzufügen |
| POST | `/counts/:id/items/bulk-add` | Mehrere Artikel hinzufügen |
| PATCH | `/counts/:countId/items/:itemId` | Zählung eintragen |
| GET | `/stock-movements` | Lagerbewegungen |
| GET | `/stock-movements/:id` | Lagerbewegung abrufen |

### Admin (`/api/admin`) - Super Admin
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/organizations` | Alle Organisationen |
| GET | `/organizations/:id` | Organisation abrufen |
| PATCH | `/organizations/:id` | Organisation aktualisieren |
| PATCH | `/organizations/:id/credits` | Credits anpassen |
| PATCH | `/organizations/:id/discount` | Rabatt setzen |
| DELETE | `/organizations/:id/discount` | Rabatt entfernen |
| POST | `/organizations/:id/access` | Support-PIN Zugang |
| GET | `/organizations/:id/impersonate` | Als Organisation agieren |
| GET | `/users` | Alle Benutzer |
| POST | `/users/:id/unlock` | Benutzer entsperren |
| GET | `/purchases` | Alle Credit-Käufe |
| POST | `/purchases/:id/complete` | Kauf abschließen |
| GET | `/invoices` | Alle Rechnungen |
| POST | `/invoices/:id/mark-paid` | Als bezahlt markieren |
| GET | `/printers` | Übersicht: Drucker-Agents und Drucker je Organisation (nur lesend) |
| POST | `/printers/:id/test` | Testdruck |
| GET | `/stats/overview` | Übersichts-Statistiken |
| GET | `/stats/revenue` | Umsatz-Statistiken |
| GET | `/audit-logs` | Audit-Logs |

### Health (`/api/health`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Basic Health Check |
| GET | `/ready` | Readiness Probe (DB, Redis, Migrationen, nicht im Herunterfahren) — 503 bei Fehler |
| GET | `/live` | Liveness Probe |
| GET | `/detailed` | Detailed Health + Memory |

## WebSocket Gateway

Das WebSocket Gateway verwendet Socket.io und unterstützt folgende Namespaces:

- `/pos` - Kassen-Clients
- `/display` - Küchen/Ausgabe-Displays
- `/printer` - Drucker-Agenten
- `/admin` - Admin-Dashboard

### Events

| Event | Richtung | Beschreibung |
|-------|----------|--------------|
| `order:created` | Server → Client | Neue Bestellung |
| `order:updated` | Server → Client | Bestellung aktualisiert |
| `order:item:ready` | Server → Client | Artikel fertig |
| `order:item:delivered` | Server → Client | Artikel geliefert |
| `payment:received` | Server → Client | Zahlung eingegangen |
| `printer:status` | Server → Client | Drucker-Status |
| `device:heartbeat` | Client → Server | Geräte-Heartbeat |
| `agentHeartbeat` | Agent → Server | Drucker-Agent: Version/OS/Fähigkeiten, Drucker online nach Fingerprint |
| `printerDiscover` | Server → Agent | Drucker neu suchen (`{ subnetScan }`) |
| `printerConfigUpdate` | Server → Agent | Druckerliste neu laden (`GET /device-api/printers`) |

## Environment Variables

| Variable | Beschreibung | Default |
|----------|--------------|---------|
| `NODE_ENV` | Environment | development |
| `PORT` | Server Port | 3000 |
| `API_PREFIX` | API Prefix | api |
| `DATABASE_HOST` | PostgreSQL Host | localhost |
| `DATABASE_PORT` | PostgreSQL Port | 5432 |
| `DATABASE_NAME` | Datenbankname | openeos |
| `DATABASE_USERNAME` | DB Benutzer | postgres |
| `DATABASE_PASSWORD` | DB Passwort | - |
| `DATABASE_POOL_MAX` | Max. connections in the pool | 10 |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | Close an idle connection after (ms) | 600000 |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | Give up waiting for a connection after (ms) | 5000 |
| `REDIS_HOST` | Redis Host | localhost |
| `REDIS_PORT` | Redis Port | 6379 |
| `JWT_SECRET` | JWT Secret Key | - |
| `JWT_EXPIRES_IN` | JWT Ablaufzeit | 30m |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh Token Ablauf | 7d |
| `CORS_ORIGINS` | Erlaubte Origins | http://localhost:3001 |
| `TRUST_PROXY` | Vertrauenswürdige Reverse-Proxys für X-Forwarded-For (Hop-Anzahl, IPs/CIDRs oder `false`) | loopback, linklocal, uniquelocal |
| `UPLOAD_DIR` | Upload-Verzeichnis — muss dem Container-Nutzer (uid 1001) gehören, siehe „Uploads“ | ./uploads |
| `EVENT_PRICE_EUR` | Preis pro abgerechnetem Veranstaltungstag | 25 |
| `BUSINESS_DAY_START_HOUR` | Tageswechsel der Abrechnung (Stunde 1–23, Ortszeit der Organisation). Ein Veranstaltungstag läuft von 6 bis 6 Uhr; ein Ende bis einschließlich 6:00 zählt zum Vortag (Sa 20 Uhr – So 2 Uhr = 1 Tag). Bereits bezahlte Veranstaltungen behalten ihre Tage. | 6 |
| `STRIPE_INVOICE_DAYS_UNTIL_DUE` | Zahlungsziel der Stripe-Rechnung beim Kauf auf Rechnung in Tagen (je Organisation überschreibbar) | 14 |
| `DATABASE_MIGRATIONS_RUN` | Migrationen beim Start ausführen (eine Instanz) | false (Vorlage `docker-compose.prod.yml`: true) |
| `SHUTDOWN_TIMEOUT_MS` | So lange dürfen offene Anfragen nach SIGTERM noch laufen | 20000 |
| `SHUTDOWN_DRAIN_DELAY_MS` | Wartezeit nach SIGTERM, in der `/api/health/ready` schon 503 meldet | 0 |
| `DEPLOY_GUARD_TOKEN` | Token für `GET /api/internal/deploy-guard` (leer: Endpunkt aus) | – |
| `AI_PROVIDER` | Assistent: `none`, `anthropic` oder `openai` (siehe „Assistent“) | none |
| `ANTHROPIC_API_KEY` | Schlüssel für `AI_PROVIDER=anthropic` | – |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Schlüssel und Basis-URL für `AI_PROVIDER=openai` (OpenAI-kompatible Chat Completions) | – / https://api.openai.com/v1 |
| `AI_MODEL_EXTRACT` / `AI_MODEL_CLASSIFY` | Modell für die Speisekarten-Extraktion / für Klassifikationen (leer: Standard je Anbieter) | – |
| `AI_MENU_IMPORTS_PER_DAY` | Speisekarten-Importe je Organisation und Tag (Europe/Berlin) | 5 |
| `AI_MENU_PAGES_PER_IMPORT` | Bilder je Import | 6 |
| `AI_CLASSIFY_PER_DAY` | Klassifikationen (Icon-Vorschläge per Modell) je Organisation und Tag | 500 |
| `AI_MAX_UPLOAD_MB` | Maximale Dateigröße je hochgeladener Speisekarte | 10 |

Siehe `.env.example` für alle verfügbaren Variablen.

### Stripe-Webhook (SaaS)

Endpunkt im Stripe-Dashboard: `<API_URL>/api/public/stripe/webhook`, Signaturgeheimnis
in `STRIPE_WEBHOOK_SECRET`. Abonniert sein müssen genau diese Ereignisse
(`STRIPE_WEBHOOK_EVENTS` in `src/modules/events/stripe-webhook.controller.ts`):

| Ereignis | Wirkung |
|----------|---------|
| `checkout.session.completed` | Zahlung verbuchen, Veranstaltung freischalten (Karte sofort; Lastschrift erst mit dem nächsten Ereignis) |
| `checkout.session.async_payment_succeeded` | Lastschrift eingegangen → freischalten |
| `checkout.session.async_payment_failed` | Lastschrift geplatzt → zurück auf „nicht freigeschaltet“, Mail an die Organisation |
| `checkout.session.expired` | Zahlungsseite abgelaufen → zurück auf „nicht freigeschaltet“, Mail an die Organisation |
| `refund.updated`, `refund.failed` | Stand der Erstattung nach Storno/Kulanz; gescheitert → Mail an den Betreiber |
| `charge.dispute.created`, `charge.dispute.closed` | Rückbuchung → Mail an den Betreiber und Admin-Protokoll, keine Sperre |
| `invoice.finalized`, `invoice.sent` | Kauf auf Rechnung: Nummer, PDF und Rechnungsseite an der Veranstaltung spiegeln |
| `invoice.paid` | Rechnung bezahlt → Zahlungsstand an der Veranstaltung, Admin-Protokoll, Mail an den Betreiber |
| `invoice.payment_failed` | Zahlung über die Rechnungsseite gescheitert → Rechnung bleibt offen, Mail an die Organisation |
| `invoice.voided`, `invoice.marked_uncollectible` | Rechnung im Dashboard storniert/abgeschrieben → ohne Bestellungen zurück auf „nicht freigeschaltet“ und Mail an die Organisation; mit Bestellungen bleibt die Freischaltung, Mail an den Betreiber |
| `credit_note.created`, `credit_note.voided` | Gutschriften (Stornorechnungen) ins Admin-Protokoll, Nummer an der Stornierung nachtragen |

Ein stündlicher Job gleicht zusätzlich alle Veranstaltungen im Zustand „Zahlung läuft“
mit Stripe ab (verlorene Webhooks, Altfälle) — siehe `EventCheckoutLifecycleService`.

### Kauf auf Rechnung (Stripe Invoicing)

Organisationen mit `billing_mode = invoice` bekommen beim Freischalten eine Rechnung
von **Stripe Invoicing**: Stripe legt den Kunden an (Name, Rechnungsadresse,
E-Mail, Sprache Deutsch), stellt die Rechnung mit einer Position je Freischaltung
(Veranstaltung, Zeitraum, Tage × Tagespreis, Nachlass als eigene Zeile) und dem
Hinweis nach § 19 UStG in der Fußzeile aus, verschickt sie mit PDF, Zahlungslink
und Bankverbindung und erinnert an die Fälligkeit. Die Veranstaltung ist sofort
freigeschaltet (`billing_status = invoice`); der Zahlungsstand steht getrennt in
`events.invoice_status`. Zahlungsziel: `STRIPE_INVOICE_DAYS_UNTIL_DUE` (Standard 14),
je Organisation überschreibbar (`organizations.invoice_days_until_due`).

Storno/Kulanz verzweigen nach Zahlweg: Stripe-Checkout → Erstattung wie bisher;
Stripe-Rechnung offen → Rechnung storniert (void); bezahlt → Stripe-Gutschrift
(Stornorechnung) mit Erstattung auf dem Zahlweg (bei Überweisung fragt Stripe die
Bankverbindung ab); als bezahlt markiert → Gutschrift ohne Erstattung, der Betreiber
überweist zurück. Super-Admins können Stripes Rechnungsmail erneut senden
(`POST /admin/events/:id/invoice/resend`) und eine außerhalb bezahlte Rechnung als
bezahlt verbuchen (`POST /admin/events/:id/invoice/mark-paid`). Ohne
`STRIPE_SECRET_KEY` bleibt es beim alten Weg (Rechnung von Hand). Im Stripe-Dashboard
müssen Rechnungen per E-Mail und die gewünschten Zahlungsarten (Überweisung,
SEPA-Lastschrift, Karte) für Rechnungen aktiviert sein.

## Assistent (KI-Funktionen)

Der Assistent hilft Vereinen beim Einrichten: **Speisekarten-Import** (Foto, PDF oder Text → Kategorien, Produkte, Preise, MwSt-Vorschlag, Pfand, Größenvarianten als Vorschau) und **Icon-Vorschläge** aus `@openeos/pos-icons`. Er ist je Organisation **opt-in** (Admin, `PATCH /api/organizations/:id/assistant`, protokolliert) und auf dem Server nur aktiv, wenn ein Anbieter konfiguriert ist (`AI_PROVIDER`). Ohne Anbieter antworten alle Assistent-Endpunkte mit `404 AI_DISABLED`, ohne Opt-in mit `403 ASSISTANT_DISABLED`. Konzept und Vertrag: `ki-plan.md` im Projekt-Root (Abschnitt 6).

**Anbieter**

- `anthropic`: Claude über die Messages API (`@anthropic-ai/sdk`), strukturierte Ausgabe per JSON-Schema, Bilder und PDFs als Base64-Blöcke in einem Aufruf.
- `openai`: Chat Completions über das offizielle `openai`-SDK mit konfigurierbarer `OPENAI_BASE_URL` — damit lassen sich auch andere OpenAI-kompatible Dienste anbinden. Strukturierte Ausgabe per `response_format: json_schema` (strict), Bilder als Data-URLs. **PDFs liest dieser Anbieter nicht** (Chat Completions kennt bei den meisten Diensten keine Dokument-Eingabe, und die API hat keine Bibliothek, die Seiten rendert): ein PDF-Upload wird für ihn mit `400 MENU_IMPORT_INVALID_FILES` abgelehnt, Fotos der Seiten gehen immer.
- `none`: aus (Standard).

Modell-IDs stehen in der Konfiguration (`AI_MODEL_EXTRACT`, `AI_MODEL_CLASSIFY`), nicht im Code.

**Kontingente und Protokoll.** Jeder Modellaufruf steht in `ai_usage` (Organisation, Funktion, Modell, Tokens, Dauer, Status). Daraus zählt `AiQuotaService` je Organisation und Kalendertag (Europe/Berlin): `AI_MENU_IMPORTS_PER_DAY` Importe, `AI_CLASSIFY_PER_DAY` Klassifikationen. Aufrufe, die beim Anbieter scheitern, kosten kein Kontingent. Bei Überschreitung antwortet die API mit `429 AI_QUOTA_EXCEEDED` und `params.resetAt`.

**Speisekarten-Import.** `POST /api/organizations/:orgId/events/:eventId/menu-imports` (multipart `files[]` oder Feld `text`) legt einen Job an (`202 { id, status: 'queued' }`); die Auswertung läuft im Hintergrund auf der Instanz, die den Upload bekam, liegengebliebene Jobs holt ein Minuten-Cron nach (Redis-Sperre, bedingtes UPDATE als Lock — kein BullMQ). Status per `GET …/menu-imports/:id` (alle 2 s pollen) oder Socket-Event `menuImportUpdated { id, eventId, status }` im Organisations-Raum. `POST …/:id/apply` legt die bestätigten Zeilen an, `DELETE` verwirft. Hochgeladene Dateien liegen unter `<UPLOAD_DIR>/menu-imports/<id>/`, sind **nicht** öffentlich (der Pfad `/uploads/menu-imports` ist in `main.ts` gesperrt) und werden beim Anwenden, Verwerfen oder nach 24 h gelöscht; der Vorschlag selbst nach 30 Tagen.

**Sicherheit.** Speisekarten sind fremder Inhalt: Das Modell liefert ausschließlich strukturierte Ausgabe gegen ein festes Schema, Text wird als `<untrusted>`-Daten übergeben, die Antwort wird vor dem Speichern Zeile für Zeile mit class-validator geprüft und nur als Vorschlag gespeichert — angelegt wird erst, was ein Mensch in der Vorschau bestätigt. Dateiinhalte und Schlüssel erscheinen nie im Log.

**Icon-Vorschläge.** `POST /api/organizations/:orgId/assistant/icon-suggestions { names[] }`. Stufe 1 ohne Modell: Namen und Suchbegriffe der Icons aus `@openeos/pos-icons` (schlanker Index im Repo, `pnpm icons:sync` nach einem Paket-Update). Stufe 2 nur für unklare Namen und nur mit freiem Kontingent: das Klassifikationsmodell wählt aus den zehn besten Kandidaten — oder ausdrücklich keines. Jeder Vorschlag trägt `source` (`lexical`: Treffer im Index, Score bis 1; `model`: Modellwahl, Score 0,6/0,5 je Sicherheit); ein leeres `suggestions`-Array heißt „kein passendes Icon“. Die Web-App sollte nur `lexical`-Treffer automatisch vorauswählen.

## Docker

```bash
# Development Environment starten
docker-compose up -d

# Logs anzeigen
docker-compose logs -f

# Container stoppen
docker-compose down

# Mit Volumes löschen
docker-compose down -v
```

## Datenbank-Änderungen: abwärtskompatibel (expand/contract)

Beim Deploy laufen die Migrationen **vor** dem Austausch der Instanzen, und
eine Weile bedienen alte und neue Version dieselbe Datenbank gleichzeitig.
Jede Migration muss deshalb mit dem **bisherigen** Code funktionieren:

1. **Expand** — nur hinzufügen: neue Tabellen, neue Spalten mit Default oder
   `NULL`, neue Indizes (bei großen Tabellen `CONCURRENTLY`). Der neue Code
   schreibt alt und neu, liest neu mit Rückfall auf alt.
2. **Migrate** — Daten umziehen (in der Migration oder per Job).
3. **Contract** — erst in einem **späteren** Release, wenn kein Code mehr die
   alte Form nutzt: Spalten/Tabellen entfernen, `NOT NULL` setzen, umbenennen.

Nicht in einem Schritt: Spalte umbenennen oder löschen, Typ ändern, `NOT NULL`
ohne Default, Enum-Werte entfernen. Umbenennen heißt: neue Spalte anlegen,
befüllen, Code umstellen — die alte Spalte fällt ein Release später weg.
Migrationen nicht nachträglich ändern; `down()` pflegen.

## Mehrere Instanzen

Die API läuft mit mehreren Instanzen hinter einem Proxy (Traefik):

- **Socket.io** verteilt Nachrichten über Redis (`RedisIoAdapter`); die
  Verbindungen bleiben per Sticky-Cookie an einer Instanz.
- **Cache** (u. a. gesperrte Zugangstoken nach dem Abmelden) liegt in Redis.
- **Zeitgesteuerte Jobs** (`@Cron`) laufen nur auf einer Instanz:
  `CronLockService` belegt die Fälligkeit per `SET … NX PX` in Redis.
- **Migrationen** laufen einmal vor dem Rollout, nicht beim Start:
  `DATABASE_MIGRATIONS_RUN=false` und vorher
  `docker compose run --rm migrate` (bzw. `pnpm migration:run:prod` im Image).
  Fehlen Migrationen, meldet `/api/health/ready` 503 — eine neue Instanz
  bekommt dann keinen Verkehr.
- **Herunterfahren**: auf SIGTERM meldet die Instanz „nicht bereit“, schließt
  die Websockets (Clients verbinden sich neu), lässt offene Anfragen bis zu
  `SHUTDOWN_TIMEOUT_MS` (20 s) zu Ende laufen und trennt erst dann Datenbank
  und Redis. Compose: `stop_grace_period: 30s`.

Eine einzelne Instanz (Vorlage `docker-compose.prod.yml`) braucht nichts davon:
sie führt die Migrationen beim Start aus.

## Automatisches Deployment

Der Workflow `.github/workflows/build-push.yml` baut das Image und spielt es
aus: `dev` → Staging, `main` → Produktion. Aktiv nur mit der Variable
`DEPLOY_ENABLED=true`.

Ablauf auf dem Server (per SSH, Compose-Verzeichnis `DEPLOY_PATH`):

1. **Deploy-Schutz** (nur Produktion): fragt `GET /api/internal/deploy-guard`.
   Läuft gerade ein Fest — eine aktive Veranstaltung mit echten Bestellungen
   (keine Testbuchungen) in den letzten 30 Minuten —, wartet der Deploy und
   fragt alle 5 Minuten erneut, höchstens 90 Minuten, dann bricht er mit
   Meldung ab. Manuell übergehen: Workflow per „Run workflow“ auf `main` mit
   `force: true` starten.
2. `docker compose pull <service>`
3. **Migrationen** als eigener Schritt: `docker compose run --rm --no-deps migrate`
   (nur wenn der Compose-Dienst `migrate` existiert).
4. **`docker rollout <service>`** ([docker-rollout](https://github.com/wowu/docker-rollout)):
   startet neue Instanzen neben den alten, wartet auf `healthy`
   (`/api/health/ready`), nimmt die alten aus dem Proxy (Pre-Stop-Hook legt
   `/tmp/drain` an, der Health-Check schlägt fehl) und stoppt sie dann.
   Werden die neuen nicht gesund, bleiben die alten aktiv, das vorige Image
   bekommt das Tag zurück und der Workflow schlägt fehl.

Fehlt `docker rollout` auf dem Server oder hat der Dienst noch einen festen
`container_name`, fällt der Workflow auf `docker compose up -d` zurück.

**Variables:** `DEPLOY_ENABLED`, `DEPLOY_PATH` / `STAGING_DEPLOY_PATH`
(Default `/srv/docker/<repo>` bzw. `/srv/docker/staging/<repo>`),
`DEPLOY_SERVICE` (Compose-Dienst), optional `DEPLOY_GUARD_URL`
(Default `https://api.openeos.de/api/internal/deploy-guard`).

**Secrets:** `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, optional
`DEPLOY_PORT`, `DEPLOY_GUARD_TOKEN` (gleicher Wert wie in der `.env` der
Produktions-API). Ohne `DEPLOY_GUARD_TOKEN` wird der Deploy-Schutz mit einer
Warnung übersprungen.

## Lizenz

Copyright (C) 2026 LUXCODE by Lukas Lukic-Spitznagel und Mitwirkende.

Lizenziert unter der GNU Affero General Public License v3.0 oder (nach deiner Wahl) jeder späteren Version (`AGPL-3.0-or-later`), siehe [LICENSE](LICENSE) und [NOTICE](NOTICE). Wer eine geänderte Fassung über ein Netzwerk anbietet, muss den Nutzer:innen den Quellcode dieser Fassung zugänglich machen (AGPL § 13).
