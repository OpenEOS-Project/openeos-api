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

Im Development-Modus ist die interaktive API-Dokumentation verfügbar unter:

```
http://localhost:3000/docs
```

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
    ├── rentals/                # Hardware-Vermietung
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
| POST | `/` | Drucker erstellen |
| GET | `/:id` | Drucker abrufen |
| PATCH | `/:id` | Drucker aktualisieren |
| DELETE | `/:id` | Drucker löschen |
| POST | `/:id/test` | Testdruck |

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

### Rentals (`/api/organizations/:orgId/rentals`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Alle Vermietungen |
| GET | `/active` | Aktive Vermietungen |
| GET | `/upcoming` | Anstehende Vermietungen |
| GET | `/:id` | Vermietung abrufen |
| POST | `/:id/confirm` | Vermietung bestätigen |
| POST | `/:id/decline` | Vermietung ablehnen |

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
| GET | `/rental-hardware` | Hardware-Pool |
| POST | `/rental-hardware` | Hardware erstellen |
| PATCH | `/rental-hardware/:id` | Hardware aktualisieren |
| DELETE | `/rental-hardware/:id` | Hardware löschen |
| GET | `/rental-assignments` | Alle Zuweisungen |
| POST | `/rental-assignments` | Zuweisung erstellen |
| POST | `/rental-assignments/:id/return` | Rückgabe |
| GET | `/stats/overview` | Übersichts-Statistiken |
| GET | `/stats/revenue` | Umsatz-Statistiken |
| GET | `/audit-logs` | Audit-Logs |

### Health (`/api/health`)
| Methode | Endpunkt | Beschreibung |
|---------|----------|--------------|
| GET | `/` | Basic Health Check |
| GET | `/ready` | Readiness Probe (DB + Redis) |
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
| `REDIS_HOST` | Redis Host | localhost |
| `REDIS_PORT` | Redis Port | 6379 |
| `JWT_SECRET` | JWT Secret Key | - |
| `JWT_EXPIRES_IN` | JWT Ablaufzeit | 30m |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh Token Ablauf | 7d |
| `CORS_ORIGINS` | Erlaubte Origins | http://localhost:3001 |
| `UPLOAD_DIR` | Upload-Verzeichnis | ./uploads |

Siehe `.env.example` für alle verfügbaren Variablen.

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

## Planungsdokumentation

- [API-Struktur](../PLAN/04-API.md)
- [Datenbankschema](../PLAN/03-DATENBANK.md)
- [Sicherheit](../PLAN/10-SICHERHEIT.md)
- [Workflow Engine](../PLAN/06-WORKFLOW-ENGINE.md)

## License

AGPLv3
