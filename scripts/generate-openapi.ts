import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from '../src/app.module';

async function generateOpenApiSpec() {
  // Create application without listening
  const app = await NestFactory.create(AppModule, {
    logger: ['error'],
  });

  // Set API prefix
  app.setGlobalPrefix('api');

  // Build Swagger config
  const config = new DocumentBuilder()
    .setTitle('OpenEOS API')
    .setDescription(`
# OpenEOS API Documentation

Open Event Ordering System - REST API für Kassensysteme bei Vereinen und Veranstaltungen.

## Authentifizierung

Die API verwendet JWT Bearer Tokens für die Authentifizierung. Nach dem Login erhältst du einen Access Token (30 Min gültig) und einen Refresh Token (7 Tage, als httpOnly Cookie).

### Endpoints ohne Authentifizierung
- \`POST /api/auth/register\` - Registrierung
- \`POST /api/auth/login\` - Login
- \`POST /api/auth/refresh\` - Token erneuern
- \`POST /api/auth/forgot-password\` - Passwort vergessen
- \`POST /api/auth/reset-password\` - Passwort zurücksetzen
- \`GET /api/health/*\` - Health Checks
- \`GET /api/invitations/:token\` - Einladung abrufen
- \`/api/public/order/*\` - Online-Bestellungen (mit Session-Token)

## Multi-Tenant

Die API ist multi-tenant-fähig. Die meisten Endpoints erfordern eine \`organizationId\` im Pfad.

## Rollen

- **ADMIN** - Vollzugriff auf Organisation
- **MANAGER** - Verwaltung von Produkten, Events, Bestellungen
- **CASHIER** - Kassen-Operationen
- **KITCHEN** - Küchen-Display
- **DELIVERY** - Ausgabe-Display

## WebSocket

Real-time Updates über Socket.io unter \`/\` mit Namespaces:
- \`/pos\` - Kassen-Clients
- \`/display\` - Küchen/Ausgabe-Displays
- \`/printer\` - Drucker-Agenten
- \`/admin\` - Admin-Dashboard
    `)
    .setVersion('1.0.0')
    .setContact('OpenEOS', 'https://github.com/openeos', 'info@openeos.de')
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addServer('http://localhost:3000', 'Development')
    .addServer('https://api.openeos.de', 'Production')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-Organization-Id',
        in: 'header',
        description: 'Organization ID for multi-tenant requests',
      },
      'X-Organization-Id',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-Session-Token',
        in: 'header',
        description: 'Session token for online orders',
      },
      'X-Session-Token',
    )
    .addTag('Auth', 'Authentication and authorization endpoints')
    .addTag('Organizations', 'Organization management and member handling')
    .addTag('Events', 'Event management and lifecycle')
    .addTag('Categories', 'Product category management with hierarchy support')
    .addTag('Products', 'Product management and stock control')
    .addTag('Orders', 'Order management and item handling')
    .addTag('Payments', 'Payment processing including split payments')
    .addTag('Devices', 'POS device management')
    .addTag('Printers', 'Printer configuration and management')
    .addTag('Print Templates', 'Print template management')
    .addTag('Print Jobs', 'Print job queue management')
    .addTag('Workflows', 'Workflow engine for automation')
    .addTag('QR Codes', 'QR code generation and management')
    .addTag('Online Orders', 'Public online ordering endpoints')
    .addTag('Credits', 'Credit/token management for SaaS billing')
    .addTag('Invoices', 'Invoice management')
    .addTag('Rentals', 'Hardware rental management')
    .addTag('Admin', 'Super admin endpoints')
    .addTag('Reports', 'Reporting and analytics')
    .addTag('Uploads', 'File upload management')
    .addTag('Inventory', 'Inventory and stock management')
    .addTag('Health', 'Health check endpoints')
    .build();

  // Generate OpenAPI document
  const document = SwaggerModule.createDocument(app, config);

  // Write JSON file
  const jsonPath = join(__dirname, '..', 'docs', 'openapi.json');
  writeFileSync(jsonPath, JSON.stringify(document, null, 2));
  console.log(`OpenAPI JSON written to: ${jsonPath}`);

  // Write YAML file
  const yaml = jsonToYaml(document);
  const yamlPath = join(__dirname, '..', 'docs', 'openapi.yaml');
  writeFileSync(yamlPath, yaml);
  console.log(`OpenAPI YAML written to: ${yamlPath}`);

  await app.close();
  console.log('OpenAPI specification generated successfully!');
}

function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj === 'boolean' || typeof obj === 'number') {
    return String(obj);
  }

  if (typeof obj === 'string') {
    // Check if string needs quoting
    if (obj.includes('\n') || obj.includes(':') || obj.includes('#') ||
        obj.includes('"') || obj.includes("'") || obj.startsWith(' ') ||
        obj.endsWith(' ') || obj === '' || /^[\d.]+$/.test(obj) ||
        ['true', 'false', 'null', 'yes', 'no'].includes(obj.toLowerCase())) {
      // Use literal block scalar for multiline strings
      if (obj.includes('\n')) {
        const lines = obj.split('\n').map(line => spaces + '  ' + line).join('\n');
        return `|\n${lines}`;
      }
      return JSON.stringify(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      const value = jsonToYaml(item, indent + 1);
      if (typeof item === 'object' && item !== null) {
        return `\n${spaces}- ${value.trim().replace(/^\n/, '').replace(/^  /, '')}`;
      }
      return `\n${spaces}- ${value}`;
    }).join('');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';

    return entries.map(([key, value]) => {
      const yamlValue = jsonToYaml(value, indent + 1);
      const quotedKey = /[:\-#\[\]{}]/.test(key) ? `"${key}"` : key;

      if (typeof value === 'object' && value !== null &&
          (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
        return `\n${spaces}${quotedKey}:${yamlValue}`;
      }
      return `\n${spaces}${quotedKey}: ${yamlValue}`;
    }).join('');
  }

  return String(obj);
}

generateOpenApiSpec().catch((err) => {
  console.error('Error generating OpenAPI spec:', err);
  process.exit(1);
});
