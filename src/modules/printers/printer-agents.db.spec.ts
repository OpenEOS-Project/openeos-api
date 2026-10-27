import { randomUUID } from 'crypto';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import {
  Device,
  DiscoveredPrinter,
  Organization,
  Printer,
  ProductionStation,
  UserOrganization,
} from '../../database/entities';
import { PrinterConnectionType } from '../../database/entities/printer.entity';
import { PrinterType } from '../../database/entities/printer.entity';
import { GatewayService } from '../gateway/gateway.service';
import { PrintersService } from './printers.service';
import { PrinterAgentsService } from './printer-agents.service';

/**
 * Erkennung, Uebernahme, Heartbeat und Entfernen eines Drucker-Agents
 * gegen ein echtes Postgres (Migration, Unique-Constraints, Kaskaden).
 *
 * Laeuft nur mit einer Wegwerf-Datenbank, z. B.
 *
 *   TEST_ORDERS_DATABASE_URL=postgres://openeos:openeos@127.0.0.1:5546/openeos_printers_scratch pnpm test
 *
 * Name muss auf `_test` oder `_scratch` enden.
 */
const TEST_DB = process.env.TEST_ORDERS_DATABASE_URL;
const describeWithDb = TEST_DB ? describe : describe.skip;

describeWithDb('PrinterAgentsService against Postgres', () => {
  let ds: DataSource;
  const orgIds: string[] = [];
  const gateway = {
    notifyPrinterStatusChanged: jest.fn(),
    notifyPrinterConfigUpdate: jest.fn(),
    notifyOrganizationSettingsUpdated: jest.fn(),
    notifyDeviceSettingsUpdated: jest.fn(),
    sendPrinterDiscover: jest.fn(),
    reassignDeviceRoom: jest.fn(),
    isDeviceOnline: jest.fn(() => Promise.resolve(true)),
    getOnlineDeviceIds: jest.fn(() => Promise.resolve([] as string[])),
  };
  let printers: PrintersService;
  let agents: PrinterAgentsService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const name = new URL(TEST_DB!).pathname.replace(/^\//, '');
    if (!/_(test|scratch)$/.test(name)) {
      throw new Error(`Database "${name}" does not end in _test/_scratch`);
    }
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [path.join(__dirname, '../../database/entities/*.entity.ts')],
      migrations: [path.join(__dirname, '../../database/migrations/*.ts')],
      migrationsRun: true,
      logging: false,
    });
    await ds.initialize();
    printers = new PrintersService(
      ds.getRepository(Printer),
      ds.getRepository(UserOrganization),
      ds.getRepository(Device),
      gateway as unknown as GatewayService,
      ds.getRepository(Organization),
      ds.getRepository(ProductionStation),
    );
    agents = new PrinterAgentsService(
      ds.getRepository(Device),
      ds.getRepository(DiscoveredPrinter),
      ds.getRepository(Printer),
      ds.getRepository(UserOrganization),
      gateway as unknown as GatewayService,
      printers,
    );
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      if (orgIds.length) {
        await ds.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
          orgIds,
        ]);
      }
      await ds.destroy();
    }
  });

  beforeEach(() => jest.clearAllMocks());

  async function q<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return await ds.query(sql, params);
  }

  async function world() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await q(
      `INSERT INTO organizations (id, name, slug, support_pin, settings)
       VALUES ($1, 'Verein', $2, '123456', '{}')`,
      [orgId, `verein-${orgId}`],
    );
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, first_name, last_name) VALUES ($1, $2, 'Anna', 'Admin')`,
      [userId, `a-${userId}@example.com`],
    );
    await q(
      `INSERT INTO user_organizations (user_id, organization_id, role, permissions)
       VALUES ($1, $2, 'admin', '{}')`,
      [userId, orgId],
    );
    const [agent] = await q<{ id: string }>(
      `INSERT INTO devices (organization_id, name, type, status, device_token, settings)
       VALUES ($1, 'Pi Küche', 'printer_agent', 'verified', $2, '{}') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    const [pos] = await q<{ id: string }>(
      `INSERT INTO devices (organization_id, name, type, status, device_token, settings)
       VALUES ($1, 'Kasse 1', 'pos', 'verified', $2, '{}') RETURNING id`,
      [orgId, `tok-${randomUUID()}`],
    );
    const [event] = await q<{ id: string }>(
      `INSERT INTO events (organization_id, name, status)
       VALUES ($1, 'Fest', 'active') RETURNING id`,
      [orgId],
    );
    const [station] = await q<{ id: string }>(
      `INSERT INTO production_stations (event_id, name) VALUES ($1, 'Grill') RETURNING id`,
      [event.id],
    );
    return {
      orgId,
      user: { id: userId } as never,
      agentId: agent.id,
      posId: pos.id,
      stationId: station.id,
    };
  }

  it('migration replaced the rental tables with discovered_printers', async () => {
    const tables = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('discovered_printers', 'rental_hardware', 'rental_assignments')`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['discovered_printers']);
    const enumValues = await q<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'printer_connection_type' ORDER BY enumsortorder`,
    );
    expect(enumValues.map((e) => e.enumlabel)).toEqual(
      expect.arrayContaining(['usb', 'network', 'windows']),
    );
  });

  it('upserts discoveries per fingerprint and keeps unreported ones on a full scan', async () => {
    const w = await world();
    const usb = {
      fingerprint: 'usb:04b8:0202:ABC',
      connectionType: PrinterConnectionType.USB,
      displayName: 'EPSON TM-T88V',
      details: {
        usbVendorId: '04b8',
        usbProductId: '0202',
        serialNumber: 'ABC',
      },
      discoveredVia: 'usb' as const,
    };
    const net = {
      fingerprint: 'net:aa:bb:cc:dd:ee:ff',
      connectionType: PrinterConnectionType.NETWORK,
      displayName: 'Star TSP143',
      details: { ipAddress: '192.168.1.50', macAddress: 'aa:bb:cc:dd:ee:ff' },
      discoveredVia: 'mdns' as const,
    };

    const first = await agents.reportDiscovered(w.agentId, w.orgId, {
      printers: [usb, net],
      full: true,
    });
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.printerId === null)).toBe(true);

    await q(
      `UPDATE discovered_printers SET last_seen_at = now() - interval '1 hour'
        WHERE device_id = $1`,
      [w.agentId],
    );

    // Second full scan only sees the USB printer with a new name.
    const second = await agents.reportDiscovered(w.agentId, w.orgId, {
      printers: [{ ...usb, displayName: 'EPSON (umbenannt)' }],
      full: true,
    });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(
      first.find((r) => r.fingerprint === usb.fingerprint)!.id,
    );

    const rows = await agents.listDiscovered(w.orgId, w.agentId, w.user);
    expect(rows).toHaveLength(2);
    const usbRow = rows.find((r) => r.fingerprint === usb.fingerprint)!;
    const netRow = rows.find((r) => r.fingerprint === net.fingerprint)!;
    expect(usbRow.displayName).toBe('EPSON (umbenannt)');
    expect(usbRow.lastSeenAt.getTime()).toBeGreaterThan(
      netRow.lastSeenAt.getTime(),
    );
    expect(usbRow.firstSeenAt.getTime()).toBeLessThan(
      usbRow.lastSeenAt.getTime(),
    );
    // Ordered by lastSeenAt DESC: the freshly seen one first.
    expect(rows[0].id).toBe(usbRow.id);
  });

  it('adopts a discovered printer, refuses a second adoption and flips it online via heartbeat', async () => {
    const w = await world();
    const [disc] = await agents.reportDiscovered(w.agentId, w.orgId, {
      printers: [
        {
          fingerprint: 'net:192.168.1.60',
          connectionType: PrinterConnectionType.NETWORK,
          displayName: 'Bondrucker',
          details: { ipAddress: '192.168.1.60', port: 9100 },
          discoveredVia: 'portscan',
        },
      ],
      full: false,
    });

    const printer = await agents.adopt(
      w.orgId,
      w.agentId,
      disc.id,
      {
        name: 'Theke',
        type: PrinterType.RECEIPT,
        paperWidth: 80,
        hasCashDrawer: true,
      },
      w.user,
    );
    expect(printer).toMatchObject({
      organizationId: w.orgId,
      deviceId: w.agentId,
      fingerprint: 'net:192.168.1.60',
      connectionType: 'network',
      connectionConfig: { ipAddress: '192.168.1.60', port: 9100 },
      hasCashDrawer: true,
      isOnline: false,
    });
    expect(gateway.notifyPrinterConfigUpdate).toHaveBeenCalledWith(
      w.orgId,
      w.agentId,
    );
    const [linked] = await q<{ printer_id: string }>(
      `SELECT printer_id FROM discovered_printers WHERE id = $1`,
      [disc.id],
    );
    expect(linked.printer_id).toBe(printer.id);

    await expect(
      agents.adopt(
        w.orgId,
        w.agentId,
        disc.id,
        {
          name: 'Nochmal',
          type: PrinterType.RECEIPT,
          paperWidth: 58,
          hasCashDrawer: false,
        },
        w.user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // Re-reporting after adoption keeps the link.
    const [again] = await agents.reportDiscovered(w.agentId, w.orgId, {
      printers: [
        {
          fingerprint: 'net:192.168.1.60',
          connectionType: PrinterConnectionType.NETWORK,
          displayName: 'Bondrucker',
          details: { ipAddress: '192.168.1.60' },
          discoveredVia: 'portscan',
        },
      ],
      full: true,
    });
    expect(again.printerId).toBe(printer.id);

    // Only adopted printers reach the agent.
    const forAgent = await printers.findByDeviceId(w.agentId);
    expect(forAgent.map((p) => p.id)).toEqual([printer.id]);

    await agents.handleAgentHeartbeat(w.agentId, w.orgId, {
      version: '2.0.0',
      os: 'linux',
      arch: 'aarch64',
      hostname: 'pi',
      pythonVersion: '3.12.0',
      capabilities: { usb: true, mdns: true, portscan: true, spooler: false },
      printers: [{ fingerprint: 'net:192.168.1.60', online: true }],
    });
    const [p] = await q<{ is_online: boolean; last_seen_at: Date }>(
      `SELECT is_online, last_seen_at FROM printers WHERE id = $1`,
      [printer.id],
    );
    expect(p.is_online).toBe(true);
    expect(p.last_seen_at).not.toBeNull();
    const [d] = await q<{ agent_info: Record<string, unknown> }>(
      `SELECT agent_info FROM devices WHERE id = $1`,
      [w.agentId],
    );
    expect(d.agent_info).toMatchObject({ version: '2.0.0', os: 'linux' });
    expect(gateway.notifyPrinterStatusChanged).toHaveBeenCalledWith(
      w.orgId,
      expect.objectContaining({ printerId: printer.id, isOnline: true }),
    );

    const list = await agents.listAgents(w.orgId, w.user);
    expect(list).toEqual([
      expect.objectContaining({
        deviceId: w.agentId,
        isOnline: false,
        agentInfo: expect.objectContaining({ version: '2.0.0' }) as unknown,
        discoveredCount: 1,
        printerCount: 1,
      }),
    ]);
  });

  it('removing the agent drops printers, discoveries and every reference', async () => {
    const w = await world();
    const [disc] = await agents.reportDiscovered(w.agentId, w.orgId, {
      printers: [
        {
          fingerprint: 'usb:0519:0001:-',
          connectionType: PrinterConnectionType.USB,
          displayName: 'Star',
          details: { usbVendorId: '0519', usbProductId: '0001' },
          discoveredVia: 'usb',
        },
      ],
      full: true,
    });
    const printer = await agents.adopt(
      w.orgId,
      w.agentId,
      disc.id,
      {
        name: 'Grill',
        type: PrinterType.KITCHEN,
        paperWidth: 80,
        hasCashDrawer: false,
      },
      w.user,
    );
    await q(`UPDATE production_stations SET printer_id = $1 WHERE id = $2`, [
      printer.id,
      w.stationId,
    ]);
    await q(`UPDATE organizations SET settings = $1 WHERE id = $2`, [
      JSON.stringify({
        orderFlow: {
          kitchenTicketPrinting: {
            enabled: true,
            printerId: printer.id,
            templateId: null,
          },
          receiptPrinting: {
            enabled: true,
            trigger: 'payment_received',
            printerId: null,
            templateId: null,
          },
        },
      }),
      w.orgId,
    ]);
    await q(`UPDATE devices SET settings = $1 WHERE id = $2`, [
      JSON.stringify({ defaultPrinterId: printer.id, soundEnabled: true }),
      w.posId,
    ]);

    await agents.removeAgent(w.orgId, w.agentId, w.user);

    expect(
      await q(`SELECT 1 FROM devices WHERE id = $1`, [w.agentId]),
    ).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM printers WHERE id = $1`, [printer.id]),
    ).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM discovered_printers WHERE device_id = $1`, [
        w.agentId,
      ]),
    ).toHaveLength(0);
    const [station] = await q<{ printer_id: string | null }>(
      `SELECT printer_id FROM production_stations WHERE id = $1`,
      [w.stationId],
    );
    expect(station.printer_id).toBeNull();
    const [org] = await q<{
      settings: {
        orderFlow: Record<
          string,
          { printerId: string | null; enabled: boolean }
        >;
      };
    }>(`SELECT settings FROM organizations WHERE id = $1`, [w.orgId]);
    expect(org.settings.orderFlow.kitchenTicketPrinting.printerId).toBeNull();
    expect(org.settings.orderFlow.kitchenTicketPrinting.enabled).toBe(true);
    const [pos] = await q<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM devices WHERE id = $1`,
      [w.posId],
    );
    expect(pos.settings).toEqual({ soundEnabled: true });
    expect(gateway.reassignDeviceRoom).toHaveBeenCalledWith(w.agentId, null);
  });

  it('manual network printers need an agent of the same organization', async () => {
    const w = await world();
    const printer = await printers.create(
      w.orgId,
      {
        deviceId: w.agentId,
        name: 'Manuell',
        type: PrinterType.RECEIPT,
        connectionConfig: { ipAddress: '10.0.0.5' },
      },
      w.user,
    );
    expect(printer).toMatchObject({
      fingerprint: null,
      connectionType: 'network',
      connectionConfig: { ipAddress: '10.0.0.5', port: 9100 },
    });
    await expect(
      printers.create(
        w.orgId,
        {
          deviceId: w.posId,
          name: 'Falsch',
          type: PrinterType.RECEIPT,
          connectionConfig: { ipAddress: '10.0.0.6' },
        },
        w.user,
      ),
    ).rejects.toMatchObject({
      response: { reason: 'DEVICE_NOT_PRINTER_AGENT' },
    });

    const updated = await printers.update(
      w.orgId,
      printer.id,
      { connectionConfig: { port: 9101 }, type: PrinterType.KITCHEN },
      w.user,
    );
    expect(updated.connectionConfig).toEqual({
      ipAddress: '10.0.0.5',
      port: 9101,
    });
    expect(updated.type).toBe('kitchen');
  });
});
