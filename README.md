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

(Rohe Spezifikation: `/docs-json`, `/docs-yaml`.) In Produktion wird `/docs` nicht ausgeliefert. Eingecheckt sind zwei Fassungen der Spezifikation:

- `docs/openapi.json` / `docs/openapi.yaml` — vollständig (alle Controller), für Swagger UI und Self-Hosting
- `docs/openapi.public.json` / `docs/openapi.public.yaml` — nur, was ein API-Token erreicht (`x-api-token-scope`), plus die Token-Verwaltung; deutsche Tags in fester Reihenfolge, nur die dafür nötigen Schemas. Daraus rendert die Doku-Seite (openeos-docs) die öffentliche API-Referenz unter docs.openeos.de/api. Welche Tags es gibt und wie sie heißen: `src/common/openapi/public-spec.ts`.

Alle entstehen aus derselben Konfiguration wie Swagger UI (`src/common/openapi/openapi-config.ts`, Einleitung, Sicherheitsschemata, Tag-Reihenfolge, lesbare operationIds):

```bash
pnpm docs:generate   # schreibt docs/openapi*.json und docs/openapi*.yaml
pnpm docs:check      # Exit 1, wenn eine eingecheckte Fassung nicht zum Code passt (läuft in CI)
```

Beide brauchen eine erreichbare Datenbank und Redis (`docker compose up -d postgres redis`), weil `AppModule` beim Start verbindet. Nach jeder Änderung an Controllern oder DTOs: `pnpm docs:generate` und das Ergebnis mit committen. Jeder Endpunkt mit `@ApiTokenAccess` braucht ein `@ApiOperation` mit `operationId`, deutscher `summary` und `description` — `src/common/openapi/openapi-public.spec.ts` prüft das gegen die eingecheckte öffentliche Fassung.

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

**Schranken.** Ein Benutzer darf in höchstens `ORGANIZATIONS_PER_USER_LIMIT` Organisationen Mitglied sein (zählt alle Mitgliedschaften, egal welche Rolle); Anlegen und Einladung annehmen antworten darüber hinaus mit `403 ORGANIZATION_LIMIT_REACHED` (`params.limit`). Eine Organisation darf höchstens `MEMBERS_PER_ORGANIZATION_LIMIT` Plätze belegen — aktive Mitglieder plus offene, nicht abgelaufene Einladungen; Einladen und Hinzufügen antworten sonst mit `403 MEMBER_LIMIT_REACHED` (`params.limit`, `params.used`). Helfer (Schichtanmeldungen, Anmeldelinks) sind keine Mitglieder und zählen nicht. Super-Admins sind von beiden Schranken ausgenommen und können im Adminbereich je Benutzer (`organizationLimit`) bzw. je Organisation (`memberLimit`) einen eigenen Wert setzen (leer = Standard, 0 = unbegrenzt). `GET /organizations/:id` liefert `memberLimit`/`memberCount`, `GET /auth/me` liefert `organizationLimit`/`organizationCount`.

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
| `TWO_FACTOR_ENCRYPTION_KEY` | Schlüssel für 2FA-Geheimnisse, in Produktion Pflicht — sichern! | – |
| `INTEGRATION_ENCRYPTION_KEY` | Schlüssel für die Zugangsdaten der Zahlungsanbieter (leer: `TWO_FACTOR_ENCRYPTION_KEY`), siehe „Zugangsdaten der Zahlungsanbieter“ — sichern! | – |
| `CORS_ORIGINS` | Erlaubte Origins | http://localhost:3001 |
| `TRUST_PROXY` | Vertrauenswürdige Reverse-Proxys für X-Forwarded-For (Hop-Anzahl, IPs/CIDRs oder `false`) | loopback, linklocal, uniquelocal |
| `UPLOAD_DIR` | Upload-Verzeichnis — muss dem Container-Nutzer (uid 1001) gehören, siehe „Uploads“ | ./uploads |
| `EVENT_PRICE_EUR` | Preis pro abgerechnetem Veranstaltungstag | 25 |
| `BUSINESS_DAY_START_HOUR` | Tageswechsel der Abrechnung (Stunde 1–23, Ortszeit der Organisation). Ein Veranstaltungstag läuft von 6 bis 6 Uhr; ein Ende bis einschließlich 6:00 zählt zum Vortag (Sa 20 Uhr – So 2 Uhr = 1 Tag). Bereits bezahlte Veranstaltungen behalten ihre Tage. | 6 |
| `EVENT_DATE_PHASES` | Phasen freigeschalteter Veranstaltungen (Geplant – Aktiv – Beendet). `false`: nur der Status zählt, wie vor 2026-11 | true |
| `EVENT_EARLY_START_HOURS` | Echte Verkäufe beginnen so viele Stunden vor dem ersten Geschäftstag (Fest am 16. → ab 15. um 18 Uhr). Mit Cloud-TSE nie im Vormonat (dann ab 0 Uhr am 1.) | 12 |
| `EVENT_EARLY_START_MAX_HOURS` | Höchster Vorlauf, den eine Veranstaltung selbst einstellen kann (`settings.sales.earlyStartHours`) | 24 |
| `EVENT_GRACE_HOURS` | Kulanz nach dem Ende des letzten Geschäftstags, danach keine neuen Bestellungen (Kassieren, Erstatten, Tische schließen gehen weiter); höchstens 13 | 6 |
| `EVENT_PLANNED_TEST_MAX_ORDERS` | Testbestellungen im Zustand „Geplant“ (vor dem Verkaufsfenster); eigene Installation unbegrenzt | 200 |
| `TSE_EVENT_SURCHARGE_EUR` | Cloud-TSE-Zuschlag je Veranstaltung (nicht je Tag) für Freischaltungen in Deutschland mit Cloud-TSE. 0 = derzeit inklusive (keine eigene Position); größer 0: Position „Cloud-TSE“ in Checkout, Rechnung und Preisvorschau, wird bei kostenloser Stornierung mit erstattet | 0 |
| `STRIPE_INVOICE_DAYS_UNTIL_DUE` | Zahlungsziel der Stripe-Rechnung beim Kauf auf Rechnung in Tagen (je Organisation überschreibbar) | 14 |
| `DATABASE_MIGRATIONS_RUN` | Migrationen beim Start ausführen (eine Instanz) | false (Vorlage `docker-compose.prod.yml`: true) |
| `SHUTDOWN_TIMEOUT_MS` | So lange dürfen offene Anfragen nach SIGTERM noch laufen | 20000 |
| `SHUTDOWN_DRAIN_DELAY_MS` | Wartezeit nach SIGTERM, in der `/api/health/ready` schon 503 meldet | 0 |
| `OPERATOR_EMERGENCY_PHONE` | Rufnummer des Notfall-Supports am Veranstaltungstag (AGB 18.2). Nur für Mitglieder und Kassen einer Organisation mit freigeschalteter, noch nicht beendeter Veranstaltung (`GET /organizations/:orgId/support/emergency`, `GET /device-api/support/emergency`) und in der Buchungsbestätigung; leer: nirgends | – |
| `DEPLOY_GUARD_TOKEN` | Token für `GET /api/internal/deploy-guard` (leer: Endpunkt aus) | – |
| `AI_PROVIDER` | Assistent: `none`, `anthropic` oder `openai` (siehe „Assistent“) | none |
| `ANTHROPIC_API_KEY` | Schlüssel für `AI_PROVIDER=anthropic` | – |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | Schlüssel und Basis-URL für `AI_PROVIDER=openai` (OpenAI-kompatible Chat Completions) | – / https://api.openai.com/v1 |
| `AI_MODEL_EXTRACT` / `AI_MODEL_CLASSIFY` | Modell für die Speisekarten-Extraktion / für Klassifikationen (leer: Standard je Anbieter) | – |
| `AI_MENU_IMPORTS_PER_DAY` | Speisekarten-Importe je Organisation und Tag (Europe/Berlin) | 5 |
| `AI_MENU_PAGES_PER_IMPORT` | Bilder bzw. PDF-Seiten je Import (PDF-Seiten zählen, wenn sie als Bilder an den Anbieter gehen) | 6 |
| `AI_CLASSIFY_PER_DAY` | Klassifikationen (Icon-Vorschläge per Modell) je Organisation und Tag | 500 |
| `AI_MAX_UPLOAD_MB` | Maximale Dateigröße je hochgeladener Speisekarte | 10 |
| `AI_REASONING_EFFORT_EXTRACT` / `AI_REASONING_EFFORT_CLASSIFY` | Nur `openai`: `reasoning_effort` je Zweck (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`); leer = nicht senden | – |
| `AI_MAX_IMAGES_PER_REQUEST` | Höchstens so viele Bilder je Modellaufruf; längere Karten werden in mehreren Aufrufen gelesen (IONOS: 4) | 0 (unbegrenzt) |
| `ORGANIZATIONS_PER_USER_LIMIT` | Höchstzahl Organisationen, in denen ein Benutzer Mitglied sein darf (Anlegen und Einladung annehmen); 0 = unbegrenzt | 5 |
| `MEMBERS_PER_ORGANIZATION_LIMIT` | Höchstzahl Mitglieder je Organisation, aktive Mitglieder plus offene Einladungen; 0 = unbegrenzt | 10 |
| `TSE_PROVIDER` | Cloud-TSE: `none` oder `swissbit` (siehe „Cloud-TSE“) | none |
| `TSE_COMING_SOON` | `true`: ohne eingerichteten Provider kündigt die gehostete Installation die Cloud-TSE als „Bald verfügbar“ an (`availability: 'coming_soon'`); eigene Installationen ignorieren den Wert | false |
| `TSE_LIFECYCLE` | `monthly` (TSE läuft für den Monat der Veranstaltung, Abmeldung am letzten Tag 20:00 Berlin; `per_event` = alter Name) oder `persistent` (TSE bleibt aktiv) | monthly |
| `SWISSBIT_BASE_URL` | Swissbit Cloud-TSE 2 (Dev: `https://dev.web-tse.de`) | https://web-tse.de |
| `SWISSBIT_VENDOR_CLIENT` / `SWISSBIT_VENDOR_SECRET` | Vendor-Zugang (Billing API: Credit Token anlegen, Nutzungsbericht, Notfall-Deaktivierung) | – |
| `SWISSBIT_CREDIT_CLIENT_ID` / `SWISSBIT_CREDIT_CLIENT_SECRET` | Credit Token der Plattform, legt TSEs an (`pnpm tse:create-credit-token`) | – |
| `SWISSBIT_PRODUCT_TYPE` | Produkttyp aus `validProductTypes` des Credit Tokens (z. B. 850007 = M) | – |
| `TSE_ENCRYPTION_KEY` | Schlüssel für die Access Tokens der TSEs (leer: `TWO_FACTOR_ENCRYPTION_KEY`) — sichern! | – |
| `TSE_EXPORT_DIR` | Ablage der TAR-Exporte (nicht öffentlich) | `UPLOAD_DIR/tse-exports` |
| `TSE_TX_TIMEOUT_MS` / `TSE_SIGN_BUDGET_MS` / `TSE_ADMIN_TIMEOUT_MS` | Zeitlimit je Transaktionsaufruf / Gesamtbudget je Vorgang / Verwaltung | 5000 / 8000 / 15000 |

Siehe `.env.example` für alle verfügbaren Variablen.

### Zugangsdaten der Zahlungsanbieter

Die SumUp- und PayPal-Zugangsdaten der Vereine (`sumup.apiKey`,
`sumup.affiliateKey`, `paypal.clientSecret` in `organizations.settings`)
liegen verschlüsselt in der Datenbank (AES-256-GCM, Präfix `enc:v1:`). Die
API entschlüsselt sie beim Laden und gibt sie nach außen weiterhin nur
maskiert heraus (`****1234`).

- **Schlüssel**: `INTEGRATION_ENCRYPTION_KEY`, leer `TWO_FACTOR_ENCRYPTION_KEY`.
  Eine bestehende Installation braucht also nichts Neues. Ohne beide startet
  die API in Produktion nicht (wie bisher); außerhalb der Produktion gilt ein
  Entwicklungsschlüssel mit Warnung.
- **Bestand**: Fünf Minuten nach dem Start verschlüsselt die API noch im
  Klartext gespeicherte Werte (beim Rollout sind die alten Instanzen dann
  ersetzt). Der Abgleich läuft bei jedem Start, schreibt nur, was noch nicht
  mit dem aktuellen Schlüssel verschlüsselt ist, und ist mit mehreren
  Instanzen gleichzeitig unbedenklich.
- **Eigenen Schlüssel nachträglich setzen**: geht jederzeit. Gelesen wird mit
  beiden Schlüsseln, der Abgleich beim nächsten Start schreibt die Werte mit
  `INTEGRATION_ENCRYPTION_KEY` neu. Danach diesen Schlüssel nicht mehr ändern
  — Werte, die sich mit keinem Schlüssel öffnen lassen, bleiben stehen
  (Fehler im Log), die Vereine müssen sie dann neu eingeben.
- **Zurück auf eine ältere Version** (vor der Verschlüsselung): die liest die
  verschlüsselten Werte nicht. SumUp und PayPal funktionieren dann erst
  wieder, wenn die Zugangsdaten neu eingegeben werden.

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
- `openai`: Chat Completions über das offizielle `openai`-SDK mit konfigurierbarer `OPENAI_BASE_URL` — damit lassen sich auch andere OpenAI-kompatible Dienste anbinden (getestet: IONOS AI Model Hub, siehe unten). Strukturierte Ausgabe per `response_format: json_schema` (strict), Bilder als Data-URLs, optional `reasoning_effort` je Zweck (`AI_REASONING_EFFORT_EXTRACT` / `_CLASSIFY`). **PDFs** kennt Chat Completions meist nicht: die API wandelt sie vorher mit `pdftoppm` (poppler-utils, im Docker-Image enthalten) in Seitenbilder (1600 px lange Kante, ≈ 137 dpi bei A4). Eine PDF mit mehr als `AI_MENU_PAGES_PER_IMPORT` Seiten wird beim Hochladen mit `400 MENU_IMPORT_INVALID_FILES` (`params.pages`) abgelehnt. Fehlt poppler-utils (Installation ohne Docker), meldet der Status `pdfSupported: false` und ein PDF-Upload wird mit Reason `MENU_IMPORT_PDF_UNSUPPORTED` abgelehnt — Fotos der Seiten gehen immer.
- `none`: aus (Standard).

Modell-IDs stehen in der Konfiguration (`AI_MODEL_EXTRACT`, `AI_MODEL_CLASSIFY`), nicht im Code.

**Fotos und Seitenzahl.** Für alle Anbieter werden Fotos vor dem Senden mit `sharp` nach EXIF gedreht und auf 1600 px lange Kante verkleinert (JPEG). Nimmt ein Dienst nur wenige Bilder je Aufruf (`AI_MAX_IMAGES_PER_REQUEST`, IONOS: 4), liest der Import längere Karten in mehreren, möglichst gleich großen Aufrufen (6 Seiten → 3 + 3); spätere Aufrufe bekommen die Kategorien und Hinweise der vorherigen Seiten als Kontext, die Teilergebnisse werden zusammengeführt. Kontingent: weiterhin ein Import, Tokens summiert.

**IONOS AI Model Hub** (OpenAI-kompatibel, Rechenzentrum Berlin) — empfohlener Anbieter und Anbieter des gehosteten Angebots (app.openeos.de); Eingaben und Antworten werden laut IONOS weder protokolliert noch gespeichert und nicht zum Training genutzt. `anthropic` bleibt für Self-Hoster eine Option. Empfohlene Konfiguration — im Anbieter-Test (11/2026, 8 Testkarten) lag `Qwen/Qwen3.8-27B` mit Reasoning `medium` bei 97 % fehlerfreien Produkten, Icon-Vorschläge brauchen Reasoning `none`:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=<Token, nur für den AI Model Hub>
OPENAI_BASE_URL=https://openai.inference.de-txl.ionos.com/v1
AI_MODEL_EXTRACT=Qwen/Qwen3.8-27B
AI_MODEL_CLASSIFY=Qwen/Qwen3.8-27B
AI_REASONING_EFFORT_EXTRACT=medium
AI_REASONING_EFFORT_CLASSIFY=none
AI_MAX_IMAGES_PER_REQUEST=4
```

Bricht ein Reasoning-Modell mit `finish=length` ab (das Nachdenken hat das Token-Limit verbraucht), steht im Log eine Warnung mit Reasoning-Tokens und dem Hinweis, `AI_REASONING_EFFORT_*` zu senken; Icon-Vorschläge bleiben dann lexikalisch.

**Kontingente und Protokoll.** Jeder Modellaufruf steht in `ai_usage` (Organisation, Funktion, Modell, Tokens, Dauer, Status). Daraus zählt `AiQuotaService` je Organisation und Kalendertag (Europe/Berlin): `AI_MENU_IMPORTS_PER_DAY` Importe, `AI_CLASSIFY_PER_DAY` Klassifikationen. Aufrufe, die beim Anbieter scheitern, kosten kein Kontingent. Bei Überschreitung antwortet die API mit `429 AI_QUOTA_EXCEEDED` und `params.resetAt`.

**Speisekarten-Import.** `POST /api/organizations/:orgId/events/:eventId/menu-imports` (multipart `files[]` oder Feld `text`) legt einen Job an (`202 { id, status: 'queued' }`); die Auswertung läuft im Hintergrund auf der Instanz, die den Upload bekam, liegengebliebene Jobs holt ein Minuten-Cron nach (Redis-Sperre, bedingtes UPDATE als Lock — kein BullMQ). Status per `GET …/menu-imports/:id` (alle 2 s pollen) oder Socket-Event `menuImportUpdated { id, eventId, status }` im Organisations-Raum. `POST …/:id/apply` legt die bestätigten Zeilen an, `DELETE` verwirft. Hochgeladene Dateien liegen unter `<UPLOAD_DIR>/menu-imports/<id>/`, sind **nicht** öffentlich (der Pfad `/uploads/menu-imports` ist in `main.ts` gesperrt) und werden beim Anwenden, Verwerfen oder nach 24 h gelöscht; der Vorschlag selbst nach 30 Tagen.

**Sicherheit.** Speisekarten sind fremder Inhalt: Das Modell liefert ausschließlich strukturierte Ausgabe gegen ein festes Schema, Text wird als `<untrusted>`-Daten übergeben, die Antwort wird vor dem Speichern Zeile für Zeile mit class-validator geprüft und nur als Vorschlag gespeichert — angelegt wird erst, was ein Mensch in der Vorschau bestätigt. Dateiinhalte und Schlüssel erscheinen nie im Log.

**Icon-Vorschläge.** `POST /api/organizations/:orgId/assistant/icon-suggestions { names[] }`. Stufe 1 ohne Modell: Namen und Suchbegriffe der Icons aus `@openeos/pos-icons` (schlanker Index im Repo, `pnpm icons:sync` nach einem Paket-Update). Stufe 2 nur für unklare Namen und nur mit freiem Kontingent: das Klassifikationsmodell wählt aus den zehn besten Kandidaten — liegt schon der beste lexikalische Treffer unter 0,35 (Rebsorten, „Export“), aus allen Icons (die Liste steht einmal im Aufruf) — oder ausdrücklich keines. Jeder Vorschlag trägt `source` (`lexical`: Treffer im Index, Score bis 1; `model`: Modellwahl, Score 0,6/0,5 je Sicherheit); ein leeres `suggestions`-Array heißt „kein passendes Icon“. Die Web-App sollte nur `lexical`-Treffer automatisch vorauswählen.

## Cloud-TSE (Swissbit)

Kassensicherung nach § 146a AO über die Swissbit Cloud-TSE 2 — als
Integration `tse` wie SumUp (Plan und API-Vertrag:
`tse-swissbit-plan.md` §8 im Projektordner).

- **Je Organisation eine TSE mit genau einem Client** (`OEOS-<12 Hex der
  Org-ID>`). Kassen-Geräte sind Terminals dieser einen Kasse; das Gerät
  steht in `tse_transactions.terminal`.
- **Signiert wird serverseitig nach dem Speichern, vor dem Bon**: jede
  Zahlung (`Kassenbeleg-V1`), jede Erstattung (negativ, mit Verweis),
  jede Pfand-Auszahlung, Tischbestellungen (`Bestellung-V1`). Testmodus
  mit aktiver TSE = Trainingsbuchung (`AVTraining`). Online-Vorkasse
  (Shop, QR mit PayPal) wird nicht signiert.
- **Ausfall**: Der Verkauf läuft immer weiter. Der Vorgang wird `failed`,
  der Bon trägt „TSE ausgefallen“, ein Ausfall wird protokolliert
  (`tse_outages`) und die Admins bekommen eine Mail. Kein Nachsignieren;
  hängende Transaktionen schließt der Abgleich (alle 5 Minuten) mit
  `AVBelegabbruch`.
- **Kosten**: Eine TSE kostet ab dem Anlegen Aktivierung + volle Monate
  bis zur endgültigen Deaktivierung. Angelegt wird sie deshalb nur mit
  einer bezahlten Veranstaltung und frühestens im Monat ihres Beginns —
  automatisch stündlich ab 5 Uhr am ersten Geschäftstag des Fests, oder
  vom Admin mit `POST /organizations/:id/tse`. Super-Admins können mit
  Begründung übersteuern.
- **All inclusive**: Schaltet eine deutsche Organisation in „Alle
  Funktionen“ eine Veranstaltung frei (Stripe-Zahlung, Rechnung oder
  erlassen), schaltet der Server die Integration `tse` selbst ein
  (Protokoll „automatisch beim Kauf“, `settings.integrations.tse.auto`) und
  die Automatik legt die TSE am ersten Veranstaltungstag an — sofort, wenn
  die Veranstaltung schon läuft. Bestandsorganisationen (Bargeld ohne TSE)
  fragt der Bezahldialog (`withTse`); „Ja“ stellt auf „Alle Funktionen“
  um. „Alle Funktionen“ ist in Deutschland ohne aktive TSE wählbar, sobald
  eine bezahlte Veranstaltung ansteht (die TSE folgt automatisch, Bargeld
  erst mit aktiver TSE). Preis: derzeit inklusive
  (`TSE_EVENT_SURCHARGE_EUR=0`).
- **Pflichtangaben beim Kauf**: Die Registrierung fragt keine Steuerdaten.
  Vor Zahlung, Rechnung oder Erlass prüft der Server offiziellen Namen
  (`settings.legalName`) und Rechnungsanschrift (`billing_address`), bei
  einem Kauf mit Cloud-TSE (DE) zusätzlich Steuernummer oder USt-IdNr.
  (Format DE) und die Anschrift der Organisation — sonst 400
  `PURCHASE_MASTER_DATA_REQUIRED` mit `params.missing`. Der Bezahldialog
  speichert fehlende Angaben über `PUT /organizations/:id/purchase-master-data`;
  der Support kann beim Erlass mit `overrideMasterData` + Grund übersteuern.
- **Lebenszyklus `monthly`** (Standard): Swissbit berechnet volle Monate.
  Die TSE läuft deshalb für den Kalendermonat ihrer Veranstaltung (weitere
  Veranstaltungen im selben Monat nutzen sie mit) und wird am letzten Tag
  um 20:00 (Berlin) abgemeldet (`planned_deactivation_at`): ab 18:00
  Kassenabschlüsse und Abschlussexport, ab 20:00 `disableSecureElement`
  (Grund `monthly_cycle`, Protokoll mit Zeitraum), danach holt der
  Export-Lauf den automatischen Abmelde-Export ab. Laufen um 20:00 die
  Geschäftstage (6–6 Uhr) einer bezahlten Veranstaltung, bleibt die TSE
  bis zum Ende des Folgemonats (Protokoll `tse_deactivation_postponed`
  mit Kostenhinweis). Lauf alle 15 Minuten, Wiederholung mit Backoff; um
  22:00 noch aktiv → Mail an `ADMIN_NOTIFY_EMAIL` und roter Hinweis in
  `GET /admin/tse/alerts`. Täglich 07:00 Prüfung: aktive TSE in einem Monat
  ohne bezahlte Veranstaltung → Mail.
- **Exporte**: Täglich 06:15 (Berlin) holt der Server alle Exporte (auch
  Swissbits automatische Nachtexporte) als TAR mit SHA-256 nach
  `TSE_EXPORT_DIR/<org>/<seriennummer>/<zeitraum>.tar` und löscht sie erst
  danach bei Swissbit (sonst nimmt Swissbit keine neuen Exporte an).
  Der Ordner wird nicht unter `/uploads` ausgeliefert. **Aufbewahrung 10
  Jahre** — den Ordner ins Backup aufnehmen.

Einrichtung:

1. Vendor-Zugang von Swissbit in `SWISSBIT_VENDOR_CLIENT`/`SECRET`.
2. Einmal einen Credit Token anlegen und die ausgegebenen Zeilen in die
   `.env` übernehmen (das Secret zeigt Swissbit nur einmal):
   `pnpm -s tse:create-credit-token > swissbit-credit.env`
   (Optionen `--remaining-tses N`, `--product-types 850007,850006`).
   Im Produktions-Container ohne Dev-Abhängigkeiten:
   `node dist/scripts/tse-create-credit-token.js > swissbit-credit.env`.
3. `SWISSBIT_PRODUCT_TYPE` aus den ausgegebenen `validProductTypes`
   wählen, `TSE_PROVIDER=swissbit`, `TSE_ENCRYPTION_KEY` setzen und sichern.

Noch ohne Swissbit-Vertrag: `TSE_PROVIDER=none` und `TSE_COMING_SOON=true`
(nur gehostet, `DEPLOYMENT_MODE` ungleich `selfhosted`). Dann melden
`GET /organizations/:id/tse` und die `tse`-Kurzfassung der Organisation
`available: false` mit `availability: 'coming_soon'` (sonst
`'not_configured'`, eingerichtet `'available'`); „Alle Funktionen“ in
Deutschland hat den Grund `tse_coming_soon` statt `tse_required`, und der
Kaufdialog meldet `tse.comingSoon` statt der TSE-Frage. Die Oberfläche
zeigt „Bald verfügbar“ statt „nicht eingerichtet“.

Test gegen die Swissbit-Entwicklungsumgebung (nie in CI; nutzt den
Zustand in `~/.config/openeos/swissbit-dev-state.json` und legt höchstens
dann eine TSE an, wenn keine mehr existiert):
`SWISSBIT_INTEGRATION=1 pnpm test -- swissbit.integration`.

## Aufbewahrung und Löschung

Das Modul `retention` löscht bzw. anonymisiert personenbezogene Daten nach
festen Fristen und bewahrt die steuerlich relevanten Kassendaten auf. Es
trennt zwei Bereiche:

- **Steuerarchiv** (TSE-Exporte, Kassenabschlüsse mit DSFinV-K-Export,
  signierte Vorgänge einschließlich Training, Kassenbuch): zehn Jahre ab dem
  Ende des Kalenderjahres, auch nach dem Ende der Organisation. Kein
  Löschlauf ändert diese Tabellen; Kassenabschlüsse sind zusätzlich per
  Datenbank-Trigger gegen Löschen gesperrt. Bestellungen, auf die das
  Steuerarchiv verweist, bleiben erhalten (ohne Gästeangaben).
- **Personenbezogene Daten außerhalb des Steuerarchivs** werden nach den
  Fristen unten gelöscht oder anonymisiert. Bedienernamen in erstellten
  Kassenabschlüssen bleiben, weil sie Teil des Abschlusses sind.

Jede Nacht um 03:30 (Europe/Berlin) läuft je Datenart ein Löschlauf, auf
genau einer Instanz (`CronLockService`), jede Datenart in einer eigenen
Transaktion. Jeder Lauf steht mit Datenart, Anzahl je Teilschritt,
Beginn/Ende, Probelauf und Fehler in `retention_runs` – ohne Inhalte.

| Datenart (`category`) | Was | Frist (Standard) | Verfahren |
|---|---|---|---|
| `guest_data` | Name, Telefon, E-Mail und Anmerkungen von Gästen in Bestellungen, Shop-Checkouts, Bestellungen am Tisch, Druckaufträgen | 30 Tage nach dem Ende der Veranstaltung (ohne Enddatum: nach der Bestellung, nur abgeschlossene) | Felder leeren; Bestellung bleibt ohne Personenbezug |
| `helper_data` | Schichtanmeldungen mit Name, E-Mail, Telefon, Anmerkungen, Notizen, Änderungsvorschläge, Helfer-Links | 30 Tage nach der letzten Schicht des Plans | löschen; Plan und Schichten bleiben |
| `auth_records` | abgelaufene Sitzungen, Einmalcodes, Anmelde- und Helfer-Links, vertrauenswürdige Geräte, Passwort-/E-Mail-Änderungslinks | nach Ablauf (1 Tag Puffer) | löschen |
| `auth_records` | angenommene/abgelaufene Einladungen, widerrufene/abgelaufene API-Tokens | 90 Tage | löschen |
| `audit_logs` | Admin-Protokoll | 90 Tage | löschen; Einträge zu Abrechnung, Cloud-TSE, Kassenabschluss und Betriebsart bleiben ohne IP/Browser |
| `audit_logs` | IP und Browser in Änderungsprotokollen der Betriebsart | 90 Tage | Felder leeren |
| `audit_logs` | Protokoll der Löschläufe | 3 Jahre | löschen |
| `support_messages` | Support-Chat | 12 Monate nach letzter Nachricht und letzter Nutzung bzw. Löschung der Organisation | löschen |
| `contact_requests` | Anfragen über die Website | 6 Monate nach „erledigt“ | löschen |
| `assistant_imports` | hochgeladene Speisekarten / Vorschläge | 24 Stunden / 30 Tage (stündlicher Job im Assistenten, hier protokolliert) | löschen |
| `webhook_deliveries` | Zustellprotokoll der Webhooks (gesendeter Inhalt, ggf. mit Gästeangaben, erste 1 KB der Antwort) | 30 Tage (`WEBHOOKS_DELIVERY_RETENTION_DAYS`; stündlicher Job im Webhook-Modul, hier protokolliert) | löschen |
| `organization_inactivity` | Organisationen ohne Nutzung | Ankündigung nach 24 Monaten, Schließung frühestens 30 Tage später | Mail an die Admins mit Exportlink, dann wie „Organisation löschen“ |
| `organization_purge` | gelöschte bzw. geschlossene Organisationen | Ankündigung, endgültig nach Exportfrist (30 Tage) und frühestens 30 Tage nach der Ankündigung | Kundendaten löschen; Steuerarchiv, Abrechnungsdaten des Betreibers und die Organisation als gesperrte Hülle (Name, Anschrift, Steuernummer) bleiben |
| `user_accounts` | Benutzerkonten ohne bestehende Organisation | Ankündigung nach 24 Monaten ohne Nutzung, Löschung frühestens 30 Tage später | anonymisieren (Name, E-Mail, Zugangsdaten, Tokens, Avatar) |
| `user_accounts` | geplante Kontolöschung (einziges Mitglied einer Organisation hat sein Konto gelöscht) | zum Termin der endgültigen Löschung der Organisation, erst nachdem sie endgültig gelöscht ist | anonymisieren wie oben, Bestätigungsmail |
| `deletion_reminders` | Erinnerungen vor Schließung bzw. endgültiger Löschung | 30, 10 und 1 Tag vor dem Termin (die Ankündigung ist die 30-Tage-Mail) | Mail an die Admins bzw. an das Konto; jede Stufe höchstens einmal |
| `fiscal_archive` | Steuerarchiv | 10 Jahre ab Ende des Kalenderjahres | nur zählen, nie löschen |

Regeln, die für alle Läufe gelten:

- **Kein Löschen ohne Exportangebot**: Organisationen und Konten werden
  erst gelöscht, wenn die Ankündigung (`retention_notices`) mindestens 30
  Tage alt ist – auch wenn die Organisation schon länger gelöscht war.
  Fristen für Kundendaten lassen sich nicht unter 30 Tage setzen.
- **Nicht während des Kassenbetriebs**: Eine Organisation mit aktiver
  Cloud-TSE, mit noch abzuholenden TSE-Exporten (35 Tage nach der
  Deaktivierung) oder mit Vorgängen ohne Kassenabschluss wird weder
  geschlossen noch endgültig gelöscht.
- Nutzung nach der Ankündigung (Buchung, Bestellung, Anmeldung) oder eine
  wiederhergestellte Organisation hebt die Ankündigung auf.
- Datensicherungen werden nicht einzeln bereinigt; gelöschte Daten laufen
  mit dem Sicherungszyklus aus.
- **Erinnerungen** (`deletion_reminders`): Vor jeder angekündigten
  Schließung wegen Inaktivität, jeder endgültigen Löschung einer
  Organisation und jeder geplanten Kontolöschung gehen Erinnerungen 30, 10
  und 1 Tag vor dem Termin raus. Die Ankündigung selbst zählt als
  30-Tage-Erinnerung. Verschickt wird jede Stufe höchstens einmal
  (`retention_notices.reminder_days`); hat der Lauf Tage verpasst, kommt nur
  die jüngste fällige Stufe. Aufgehobene oder ausgeführte Ankündigungen
  und wiederhergestellte Organisationen bekommen keine Erinnerung.
  Organisationen, deren Admins ihr Konto mitlöschen lassen, bekommen keine
  eigene Mail: Die Erinnerung zur Kontolöschung nennt sie. Probelauf: nur
  zählen (`remindersDue`).

**Probelauf.** `RETENTION_DRY_RUN=true` führt jeden Lauf vollständig aus
und rollt ihn am Ende zurück: Die Zahlen im Protokoll stimmen, geändert
wird nichts, Mails und Dateilöschungen bleiben aus. Standard ist der
Probelauf – auch bei `NODE_ENV=production`, weil Staging ebenso läuft.
Echte Läufe erst nach Prüfung des Protokolls mit `RETENTION_DRY_RUN=false`
einschalten.

**Super-Admin-API** (`/api/admin/retention`):

- `GET config` – wirksame Fristen und Modus
- `GET runs?category=&trigger=&organizationId=` – Protokoll, mit Namen der
  Organisation und der ausführenden Person (`organizationName`,
  `executedBy`)
- `POST runs { categories?, dryRun? }` – Lauf von Hand (ohne `dryRun` gilt
  die Einstellung der Instanz)
- `GET notices?open=true` – angekündigte Schließungen und Löschungen
- `POST organizations/:id/keep`, `POST users/:id/keep` – Ankündigung wegen
  Inaktivität aufheben (zählt als Nutzung)
- `POST organizations/:id/erasures { kind, id | email, reason, dryRun? }` –
  Einzellöschung auf Weisung des Kunden: `order` (Gästeangaben einer
  Bestellung), `guest_email` (alle Bestellangaben zu einer Adresse),
  `shift_registration` (eine Anmeldung), `helper_email` (alle Anmeldungen
  zu einer Adresse). Steht mit ausführender Person und Anlass im Protokoll
  (`trigger = instruction`).
- `POST organizations/:id/purge { confirmName, reason, dryRun? }` – sofortige
  endgültige Löschung auf Verlangen des Kunden (AVV 10.2, AGB 20.5), vor
  Ablauf der Exportfrist. Exakter Name zur Bestätigung, Anlass mindestens
  10 Zeichen. Gleiche Regeln wie der nächtliche Lauf: Steuerarchiv bleibt,
  409 `ORGANIZATION_PURGE_BLOCKED` bei aktiver Cloud-TSE, laufender Abholung
  der Rest-Exporte oder Vorgängen ohne Kassenabschluss. Noch nicht gelöschte
  Organisationen werden im selben Schritt geschlossen. Protokoll mit
  `trigger = instruction`, die Admins bekommen eine Bestätigung.

**Nur-lesen-Zugang in der Exportfrist** (AGB 10.4, AVV 10.2). Eine
gelöschte bzw. geschlossene Organisation bleibt bis zur endgültigen Löschung
für ihre Administratoren sichtbar (`GET /organizations`, `/auth/me`, jeweils
mit `closure: { closedAt, finalDeletionAt, purged, readOnly }`). Der globale
`OrganizationClosureGuard` lässt für sie nur GET/HEAD/OPTIONS zu (403
`ORGANIZATION_READ_ONLY`), außer an Export-Endpunkten mit
`@ClosedOrganizationAccess()` (TSE-Export anstoßen, Kassenabschluss für den
DSFinV-K-Export). Andere Mitglieder: 403 `ORGANIZATION_CLOSED`; öffentliche
Seiten (Shop, Bestellung am Tisch): 404; Geräte und API-Tokens der
Organisation werden abgewiesen. `finalDeletionAt` ist der Termin der
Ankündigung, sonst Löschzeitpunkt plus `RETENTION_EXPORT_PERIOD_DAYS`.

**„Löschung abbrechen“ für Vereine.** `POST /organizations/:id/restore`
(Admins, auch in der Exportfrist erlaubt) holt eine gelöschte bzw.
geschlossene Organisation zurück, solange sie nicht endgültig gelöscht ist.
Die Ankündigung verfällt (`cancel_reason = restored`), der Zeitpunkt zählt
als Nutzung. Wer sein Konto mitlöschen lässt, bricht stattdessen die
Kontolöschung ab.

**Protokoll der Löschungen durch den Verein** (Löschkonzept 1.5/5.3). Auch
Löschungen, die der Verein selbst auslöst, stehen in `retention_runs` – mit
ausführender Person, Zeitpunkt, Datenart, Anzahl und Kennungen
(`details`), nie mit Namen, E-Mail-Adressen oder Notizen:

| Vorgang | `category` | `trigger` | Zahlen / Kennungen |
|---|---|---|---|
| Organisation löschen bzw. Löschung abbrechen | `organization_closure` | `club` | `organizationsClosed` bzw. `organizationsRestored` |
| Mitglied entfernen | `memberships` | `club` | `membershipsDeleted`; `membershipId`, `userId` |
| Schichtanmeldung löschen, auch mit Schichtplan, Job oder Schicht | `helper_data` | `club` | `registrationsDeleted` (+ `shiftPlansDeleted` …); `registrationIds` |
| Helfer meldet sich über seinen Link selbst ab | `helper_data` | `self_service` | `registrationsDeleted`; `registrationIds` |
| Konto löschen, geplante Löschung, Abbruch | `user_accounts` | `self_service` | `accountsAnonymised`, `accountDeletionsScheduled`, `accountDeletionsCancelled`; `organizationIds` |

Der Super-Admin sieht sie mit den übrigen Läufen und Einzellöschungen unter
`GET /api/admin/retention/runs?trigger=club` bzw. in der App unter
„Löschprotokoll“.

**Selbstbedienung für Benutzer:**

- `GET /users/me/deletion` – was „Konto löschen“ bewirkt: sperrende
  Organisationen (letzter Admin bei weiteren Mitgliedern, laufender oder
  bezahlter kommender Veranstaltung, aktiver Cloud-TSE), Organisationen, die
  mitgelöscht werden (einziges Mitglied), offene Kassenvorgänge, Weg der
  Bestätigung (Passwort oder Code per E-Mail).
- `POST /users/me/deletion/code`, `POST /users/me/deletion { password | code }`
  – anonymisiert das Konto wie der Lauf `user_accounts`, schickt eine
  Bestätigung an die bisherige Adresse und meldet ab. Protokoll mit
  `trigger = self_service`. Super-Admins können sich nicht selbst löschen.
- Ist der Benutzer **einziges Mitglied** einer Organisation, geht sie mit –
  und damit jemand die 30-tägige Exportfrist nutzen kann, wird das Konto
  dann nicht sofort gelöscht, sondern **geplant** (Antwort `scheduled: true,
  dueAt`): Organisation geschlossen (nur lesend), Ankündigungen
  `organization_deletion` und `account_deletion` mit demselben Termin,
  `users.deletion_due_at` gesetzt, Mitgliedschaften in anderen
  Organisationen und API-Tokens sofort entfernt. Bis zum Termin kann sich
  der Benutzer anmelden und exportieren, aber keine Organisation anlegen
  und keiner beitreten (403/409 `ACCOUNT_DELETION_SCHEDULED`). Er bekommt
  die Bestätigung (= 30-Tage-Mail) und die Erinnerungen 10 und 1 Tag
  vorher; nach der endgültigen Löschung der Organisation anonymisiert der
  Lauf `user_accounts` das Konto. `GET /users/me/deletion` liefert dann
  `scheduled: { requestedAt, dueAt, organizations }`.
- `POST /users/me/deletion/cancel` – „Löschung abbrechen“: holt Konto und
  Organisationen zurück, solange keine endgültig gelöscht ist (409
  `ORGANIZATION_ALREADY_PURGED`). Entfernte Mitgliedschaften und API-Tokens
  bleiben weg. Protokoll mit `trigger = self_service`.
- `GET|PUT /users/me/newsletter { subscribed }` – Einwilligung in
  Neuigkeiten geben bzw. widerrufen. `newsletter_opt_in_at` (letzte
  Einwilligung) bleibt beim Widerruf stehen, `newsletter_opt_out_at` hält
  den Widerruf fest. `POST /public/newsletter/unsubscribe { token }` (auch
  `?token=` für RFC 8058 One-Click) widerruft über einen signierten
  Abmeldelink ohne Ablauf; den Link für künftige Mails baut
  `NewsletterService.unsubscribeUrl(userId)` (`/newsletter/abmelden?token=…`).
  Versendet wird noch nichts.

**Konfiguration** (leer = Standard):

| Variable | Standard |
|---|---|
| `RETENTION_ENABLED` | `true`, bei `DEPLOYMENT_MODE=selfhosted` `false` |
| `RETENTION_DRY_RUN` | `true` (Probelauf); echte Läufe nur mit `false` |
| `RETENTION_CATEGORIES` | alle (kommagetrennte Liste zum Einschränken) |
| `RETENTION_CONTACT_EMAIL` | `OPERATOR_EMAIL` – Adresse für Exportanfragen in der Löschankündigung |
| `RETENTION_GUEST_DATA_DAYS` / `RETENTION_HELPER_DATA_DAYS` | 30 (min. 30) |
| `RETENTION_AUDIT_LOG_DAYS` / `RETENTION_STALE_CREDENTIAL_DAYS` | 90 |
| `RETENTION_SUPPORT_MONTHS` / `RETENTION_CONTACT_MONTHS` | 12 / 6 |
| `RETENTION_INACTIVE_ORG_MONTHS` / `RETENTION_INACTIVE_USER_MONTHS` | 24 / 24 |
| `RETENTION_NOTICE_DAYS` / `RETENTION_EXPORT_PERIOD_DAYS` | 30 / 30 (min. 30) |
| `RETENTION_FISCAL_ARCHIVE_YEARS` / `RETENTION_RUN_LOG_YEARS` | 10 (min. 10) / 3 |

Tests gegen eine Wegwerf-Datenbank (Name auf `_test` oder `_scratch`):
`TEST_RETENTION_DATABASE_URL=postgres://… pnpm test retention.db`.

## Webhooks

Ausgehende Webhooks (AGB Ziffer 10.2): OpenEOS meldet Ereignisse einer
Organisation als signierten `POST` an Adressen, die ihre Admins anlegen
(Web-App *Einstellungen → Webhooks* oder `/api/organizations/:id/webhooks`,
Scopes `webhooks:read`/`webhooks:write`). Doku für Empfänger:
https://docs.openeos.de/integrationen/webhooks

**Ablauf.** Datenbank-Trigger auf `orders`, `payments`, `refunds`,
`pfand_returns`, `cash_point_closings`, `events` und `products` schreiben
Ereignisse in `webhook_outbox` — nur für Organisationen mit aktivem
Endpunkt, und ein Fehler dabei wird abgefangen (nie bricht ein Webhook eine
Buchung ab). Die Phase einer Veranstaltung ist abgeleitet; ihren Wechsel
(`event.phase_changed`) meldet ein Minuten-Job. Jede Instanz holt alle
`WEBHOOKS_POLL_INTERVAL_MS` den Postausgang (frühestens 2 s nach der
Änderung, damit Positionen dabei sind), baut je Endpunkt den Inhalt
(Betriebsart „Nur Bons“ ohne Beträge, Gästedaten nur mit
`includeGuestData`, Testbestellungen nur mit `includeTestOrders`) und
stellt zu: `OpenEOS-Signature: t=…,v1=hex(HMAC-SHA256(secret, t + "." +
body))`, Zeitlimit, keine Weiterleitungen, acht Versuche über rund 24 h
(sofort, 1 min, 5 min, 30 min, 2 h, 5 h, 8 h, 8 h, ±10 %). Nach
`WEBHOOKS_DISABLE_AFTER_FAILURES` Fehlversuchen in Folge, die mindestens
`WEBHOOKS_DISABLE_AFTER_HOURS` dauern, wird der Endpunkt abgeschaltet und
die Admins bekommen eine Mail.

**SSRF.** Nur `https://`, keine Zugangsdaten in der Adresse; jede
aufgelöste Adresse muss öffentlich sein (gesperrt: privat, Loopback,
link-local inkl. 169.254.169.254, CGNAT, ULA, Multicast, Dokumentations-
und reservierte Netze, IPv4 in IPv6). Geprüft beim Anlegen und vor jedem
Versand; die Verbindung geht an genau die geprüfte Adresse (Schutz vor
DNS-Rebinding).

**Geheimnis.** `whsec_…`, verschlüsselt gespeichert (Schlüssel wie bei den
Zahlungsanbietern: `INTEGRATION_ENCRYPTION_KEY`, sonst
`TWO_FACTOR_ENCRYPTION_KEY`), einmal angezeigt; nach dem Erneuern signiert
das alte 24 h mit.

| Variable | Standard | Bedeutung |
|---|---|---|
| `WEBHOOKS_ENABLED` | `true` | Aus: kein Versand, Anlegen/Testen antwortet `503 WEBHOOKS_DISABLED`; der Postausgang wird stündlich geleert |
| `WEBHOOKS_TIMEOUT_MS` | `10000` | Zeit je Versuch bis zur vollständigen Antwort (1–30 s) |
| `WEBHOOKS_MAX_ATTEMPTS` | `8` | Versuche je Zustellung (1–8) |
| `WEBHOOKS_MAX_ENDPOINTS_PER_ORG` | `10` | Endpunkte je Organisation |
| `WEBHOOKS_DISABLE_AFTER_FAILURES` | `30` | Fehlversuche in Folge bis zum Abschalten … |
| `WEBHOOKS_DISABLE_AFTER_HOURS` | `24` | … wenn die Fehlerserie mindestens so lange dauert |
| `WEBHOOKS_DELIVERY_RETENTION_DAYS` | `30` | Aufbewahrung des Zustellprotokolls |
| `WEBHOOKS_POLL_INTERVAL_MS` | `3000` | Takt je Instanz |
| `WEBHOOKS_CONCURRENCY` | `10` | gleichzeitige Zustellungen je Instanz |
| `WEBHOOKS_ALLOW_HTTP` | `false` | `http://` erlauben (nur eigene Installation im LAN) |
| `WEBHOOKS_ALLOW_PRIVATE_NETWORKS` | `false` | private Netze/Loopback als Ziel erlauben (eigene Installation); link-local und Metadaten bleiben gesperrt |

Tests gegen Postgres: `TEST_WEBHOOKS_DATABASE_URL=postgres://…/openeos_webhooks_test pnpm test webhooks.db`.

## MCP (KI-Agenten)

Die API ist ein [MCP](https://modelcontextprotocol.io)-Server: Claude Desktop, Claude Code, Cursor und eigene Agenten bedienen OpenEOS über dieselben Werkzeuge. Nur Administration — keine Kasse, keine Erstattungen, keine Mitglieder, kein Löschen, keine Freischaltung.

- **Endpunkt:** `https://api.openeos.de/mcp` (Streamable HTTP, zustandslos, JSON-Antworten; außerhalb von `/api`). Selbst gehostet: `https://<dein-host>/mcp`. Nur `POST`; `GET` (SSE-Strom) und `DELETE` (Sitzung) antworten mit `405` und `Allow: POST`, weil es keine Sitzungen gibt. Die Server-Version ist dieselbe wie bei `/health`.
- **Anmeldung:** `Authorization: Bearer oeos_…` mit einem API-Token der Organisation (Einstellungen → Organisation → Zugänge). Sitzungen (JWT) werden abgewiesen. Ohne gültigen Token antwortet der Server mit `401` und `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`; die Metadaten (RFC 9728) nennen `bearer_methods_supported: ["header"]` und noch keinen Autorisierungsserver — OAuth 2.1 für claude.ai-Connectors folgt in Phase 3.
- **Scopes:** `tools/list` zeigt nur Werkzeuge, die der Token darf (`read` für alles Lesende, `catalog:write`, `events:write`, `tables:write`, `staff:write`, `devices:write`, `settings:write` für das jeweilige Schreiben); `tools/call` prüft den Scope serverseitig noch einmal. Rolle und Modul-Berechtigungen des Token-Besitzers gelten wie in der Web-App.
- **Schreiben nur mit Bestätigung:** Jedes schreibende Werkzeug hat `confirm`. Ohne `confirm: true` kommt eine Vorschau (`preview: true`, `summary`, `wouldCreate`/`changes`) und nichts ändert sich. Die Vorschau prüft dasselbe wie das Ausführen (inkl. erlaubter Steuersätze) und listet Fehler je Zeile; mehrere Zeilen werden in einer Transaktion geschrieben — alles oder nichts. Jede ausgeführte Änderung landet in `admin_audit_logs` (`agent_tool_call`, `via: agent`, Werkzeug, Token, Hash der Eingabe); „Keine Änderung“ (`noChange: true`) und Fehler nicht.
- **Grenzen:** dieselben wie für den Token per REST (120 Aufrufe/min, 5.000/Tag, gemeinsamer Zähler).
- **Ressourcen:** `openeos://docs/produkte`, `…/veranstaltungen`, `…/tische`, `…/drucker`, `…/schichten` (Doku-Auszüge). **Prompts:** `setup_event` (Veranstaltung einrichten), `daily_summary` (Tagesabschluss).
- **Werkzeuge:** `src/modules/agent-tools/README.md` (Aufbau, neues Werkzeug) und `ki-plan.md` Abschnitt 9 (Liste mit Schemas).

### Claude Code

```bash
claude mcp add --transport http openeos https://api.openeos.de/mcp --header "Authorization: Bearer oeos_…"
```

oder in `.mcp.json` des Projekts:

```json
{
  "mcpServers": {
    "openeos": {
      "type": "http",
      "url": "https://api.openeos.de/mcp",
      "headers": { "Authorization": "Bearer oeos_…" }
    }
  }
}
```

### Claude Desktop

Claude Desktop verbindet entfernte Server nur per OAuth; bis Phase 3 geht der Weg über `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openeos": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://api.openeos.de/mcp",
        "--header", "Authorization:${OPENEOS_AUTH}"
      ],
      "env": { "OPENEOS_AUTH": "Bearer oeos_…" }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "openeos": {
      "url": "https://api.openeos.de/mcp",
      "headers": { "Authorization": "Bearer oeos_…" }
    }
  }
}
```

### Eigener Client

```bash
curl -s https://api.openeos.de/mcp \
  -H "Authorization: Bearer oeos_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

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
- **Webhooks** stellen alle Instanzen zu; Postausgang und fällige
  Zustellungen holt jede mit `FOR UPDATE SKIP LOCKED` (siehe „Webhooks“).
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
