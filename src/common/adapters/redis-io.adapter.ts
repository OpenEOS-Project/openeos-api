import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Logger } from '@nestjs/common';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.io adapter backed by Redis pub/sub so broadcasts, rooms and
 * fetchSockets() work across multiple API replicas. Without it the gateway
 * only reaches sockets connected to the local process.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter>;

  async connectToRedis(host: string, port: number, password?: string): Promise<void> {
    const url = password
      ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
      : `redis://${host}:${port}`;

    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => this.logger.error(`Redis pub client: ${err.message}`));
    subClient.on('error', (err) => this.logger.error(`Redis sub client: ${err.message}`));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log(`Socket.io Redis adapter connected (${host}:${port})`);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
