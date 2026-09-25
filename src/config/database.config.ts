import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Voreinstellungen für den Verbindungspool (node-postgres).
 *
 * - max 10: So viele Verbindungen hielt die API schon bisher höchstens
 *   (`poolSize: 10`), am Lastprofil ändert sich also nichts. Die
 *   Datenbank erlaubt 100 (Postgres-Standard `max_connections`); selbst
 *   wenn Produktion und Staging dieselbe Instanz nutzten, blieben 80 frei
 *   für Migrationen, psql und Wartung.
 * - idle 10 min: Freie Verbindungen bleiben erhalten, statt nach den
 *   10 s des pg-Standards geschlossen und beim nächsten Aufruf für je
 *   rund 70 ms neu aufgebaut zu werden.
 * - connect 5 s: Bisher gab es keine Grenze. Ist der Pool erschöpft oder
 *   die Datenbank weg, wartete eine Anfrage beliebig lange. Jetzt kommt
 *   nach 5 s ein Fehler. Das reicht, um kurze Lastspitzen in der
 *   Warteschlange abzufangen.
 *
 * Jeder Wert lässt sich per ENV überschreiben (siehe `.env.example`).
 */
export const POOL_VOREINSTELLUNG = {
  max: 10,
  idleTimeoutMillis: 10 * 60 * 1000,
  connectionTimeoutMillis: 5000,
} as const;

export interface PoolOptionen {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

function ganzzahl(wert: string | undefined, voreinstellung: number): number {
  if (wert === undefined || wert.trim() === '') return voreinstellung;
  const zahl = Number(wert);
  return Number.isInteger(zahl) && zahl > 0 ? zahl : voreinstellung;
}

/** Pool-Optionen aus der Umgebung; ungültige oder fehlende Werte → Voreinstellung. */
export function poolOptionen(
  env: NodeJS.ProcessEnv = process.env,
): PoolOptionen {
  return {
    max: ganzzahl(env.DATABASE_POOL_MAX, POOL_VOREINSTELLUNG.max),
    idleTimeoutMillis: ganzzahl(
      env.DATABASE_POOL_IDLE_TIMEOUT_MS,
      POOL_VOREINSTELLUNG.idleTimeoutMillis,
    ),
    connectionTimeoutMillis: ganzzahl(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      POOL_VOREINSTELLUNG.connectionTimeoutMillis,
    ),
  };
}

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'openeos',
    password: process.env.DATABASE_PASSWORD || 'openeos_dev_password',
    database: process.env.DATABASE_NAME || 'openeos',
    entities: [__dirname + '/../database/entities/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    migrationsRun: process.env.DATABASE_MIGRATIONS_RUN === 'true',
    /* Geht unverändert an den pg-Pool. `max` steht nur hier, nicht
       zusätzlich als TypeORM-`poolSize` — `extra` gewänne ohnehin. */
    extra: poolOptionen(),
  }),
);
