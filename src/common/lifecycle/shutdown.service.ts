import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server } from 'http';

/** Longest wait for open requests before connections are cut. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

function envMs(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Graceful shutdown on SIGTERM (`app.enableShutdownHooks()` in main.ts).
 *
 * Nest then closes in this order: this hook, the websocket servers (clients
 * reconnect — to another instance, if there is one), the HTTP server (no
 * new connections, open requests finish), and only then database, Redis
 * and the scheduler.
 *
 * This hook:
 * - marks the instance as draining, so `/api/health/ready` answers 503;
 * - optionally waits `SHUTDOWN_DRAIN_DELAY_MS` (default 0) while still
 *   serving, for proxies that only notice a failing readiness check. With
 *   docker-rollout the pre-stop hook does that before SIGTERM arrives;
 * - cuts whatever is still open after `SHUTDOWN_TIMEOUT_MS` (default 20 s),
 *   so a hanging request can not hold the shutdown until the container
 *   runtime kills the process.
 */
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);
  private draining = false;

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  get isDraining(): boolean {
    return this.draining;
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const delayMs = envMs('SHUTDOWN_DRAIN_DELAY_MS', 0);
    const timeoutMs = envMs('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.logger.log(
      `${signal ?? 'Shutdown'}: draining, open requests get up to ${timeoutMs / 1000} s`,
    );

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    if (!server) return;

    const force = setTimeout(() => {
      this.logger.warn(
        `Requests still open after ${timeoutMs / 1000} s — closing connections`,
      );
      server.closeAllConnections();
    }, timeoutMs);
    // Der Zeitgeber allein soll den Prozess nicht am Leben halten.
    force.unref();
  }
}
