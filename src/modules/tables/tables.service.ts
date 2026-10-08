import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not, QueryFailedError } from 'typeorm';
import {
  DiningTable,
  DiningTableShape,
} from '../../database/entities/dining-table.entity';
import {
  TableArea,
  TableAreaDecor,
  TableAreaPoint,
} from '../../database/entities/table-area.entity';
import {
  Order,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities/order.entity';
import {
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { User } from '../../database/entities/user.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { GatewayService } from '../gateway/gateway.service';
import {
  BulkCreateDiningTablesDto,
  CreateDiningTableDto,
  CreateTableAreaDto,
  PutTableAreaLayoutDto,
  ReorderTableAreasDto,
  TableAreaDecorDto,
  TableAreaPointDto,
  UpdateDiningTableDto,
  UpdateTableAreaDto,
  isShapeDecor,
} from './dto';
import {
  LABEL_MAX,
  LINE_POINTS_MIN,
  POLYGON_POINTS_MIN,
  SHAPE_POINTS_MAX,
  tableKey,
} from './tables.constants';
import {
  TABLE_STATUS_SQL,
  TableStatusEntry,
  TableStatusOrderRow,
  aggregateTableStatus,
} from './table-status';

export type TableAreaWithTables = TableArea & { tables: DiningTable[] };

/** Offen = noch zu kassieren; abgeschlossene/stornierte zaehlen nicht. */
const OPEN_ORDER_WHERE = {
  paymentStatus: In([PaymentStatus.UNPAID, PaymentStatus.PARTLY_PAID]),
  status: Not(In([OrderStatus.CANCELLED, OrderStatus.COMPLETED])),
};

const DEFAULT_TABLE_SIZE = 80;

/** Bezeichnungen einer Serie, z. B. A + 1..12 mit 2 Stellen → A01…A12. */
export function bulkLabels(
  prefix: string,
  start: number,
  count: number,
  padding: number,
): string[] {
  return Array.from(
    { length: count },
    (_, i) => `${prefix}${String(start + i).padStart(padding, '0')}`,
  );
}

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

function isUniqueViolation(error: unknown, index: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as
    | { code?: string; constraint?: string }
    | undefined;
  return (
    driverError?.code === '23505' &&
    (!driverError.constraint || driverError.constraint === index)
  );
}

@Injectable()
export class TablesService {
  private readonly logger = new Logger(TablesService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
  ) {}

  // ---------------------------------------------------------------------
  // Lesen

  async listAreas(
    organizationId: string,
    user: User,
  ): Promise<TableAreaWithTables[]> {
    await this.checkMembership(organizationId, user.id);
    return this.loadAreas(organizationId);
  }

  /**
   * Bereiche einer Organisation inkl. Tischen, sortiert. Ohne
   * Benutzerpruefung — fuer Geraete-Endpunkte (P2b).
   */
  async loadAreas(
    organizationId: string,
    options: { areaIds?: string[] | null; activeTablesOnly?: boolean } = {},
  ): Promise<TableAreaWithTables[]> {
    const areaRepo = this.dataSource.getRepository(TableArea);
    const tableRepo = this.dataSource.getRepository(DiningTable);

    const areaWhere: Record<string, unknown> = { organizationId };
    if (options.areaIds) {
      if (options.areaIds.length === 0) return [];
      areaWhere.id = In(options.areaIds);
    }
    const areas = await areaRepo.find({ where: areaWhere });
    if (areas.length === 0) return [];

    const tableWhere: Record<string, unknown> = {
      organizationId,
      areaId: In(areas.map((a) => a.id)),
    };
    if (options.activeTablesOnly) tableWhere.isActive = true;
    const tables = await tableRepo.find({ where: tableWhere });

    return areas
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || naturalCompare(a.name, b.name),
      )
      .map((area) =>
        Object.assign(area, {
          tables: tables
            .filter((t) => t.areaId === area.id)
            .sort(
              (a, b) =>
                a.sortOrder - b.sortOrder || naturalCompare(a.label, b.label),
            ),
        }),
      );
  }

  /**
   * Status aller nicht freien Tische eines Events (§2.4). Wird vom
   * Geraete-Controller (P2b) aufgerufen; das Event muss dort bereits auf
   * die Organisation des Geraets geprueft sein.
   */
  async getStatus(
    organizationId: string,
    eventId: string,
  ): Promise<TableStatusEntry[]> {
    const rows: TableStatusOrderRow[] = await this.dataSource.query(
      TABLE_STATUS_SQL,
      [organizationId, eventId],
    );
    return aggregateTableStatus(rows);
  }

  // ---------------------------------------------------------------------
  // Bereiche

  async createArea(
    organizationId: string,
    dto: CreateTableAreaDto,
    user: User,
  ): Promise<TableArea> {
    await this.checkWritePermission(organizationId, user.id);
    const repo = this.dataSource.getRepository(TableArea);

    const existing = await repo.find({ where: { organizationId } });
    this.assertAreaNameFree(existing, dto.name);

    const area = repo.create({
      organizationId,
      name: dto.name,
      width: dto.width ?? 1200,
      height: dto.height ?? 800,
      gridSize: dto.gridSize ?? 20,
      decor: [],
      sortOrder:
        existing.reduce((max, a) => Math.max(max, a.sortOrder), -1) + 1,
    });
    await this.saveArea(repo.manager, area);

    this.logger.log(`Table area created: ${area.name} (${area.id})`);
    this.gatewayService.notifyTablesUpdated(organizationId);
    return area;
  }

  async updateArea(
    organizationId: string,
    areaId: string,
    dto: UpdateTableAreaDto,
    user: User,
  ): Promise<TableArea> {
    await this.checkWritePermission(organizationId, user.id);

    const area = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TableArea);
      const area = await this.getArea(manager, organizationId, areaId);

      if (dto.name != null && dto.name !== area.name) {
        const others = await repo.find({ where: { organizationId } });
        this.assertAreaNameFree(
          others.filter((a) => a.id !== area.id),
          dto.name,
        );
        area.name = dto.name;
      }
      if (dto.width != null) area.width = dto.width;
      if (dto.height != null) area.height = dto.height;
      if (dto.gridSize != null) area.gridSize = dto.gridSize;
      // Kleinere Karte: Punkte von Umriss, Waenden und Zonen an den Rand ziehen.
      if (dto.width != null || dto.height != null) this.clampShapes(area);
      this.applyShapes(area, dto);
      await this.saveArea(manager, area);

      // Kleinere Karte: Tische an den Rand ziehen statt abzulehnen.
      if (dto.width != null || dto.height != null) {
        const tableRepo = manager.getRepository(DiningTable);
        const tables = await tableRepo.find({
          where: { organizationId, areaId: area.id },
        });
        const moved = tables.filter(
          (t) => t.x > area.width || t.y > area.height,
        );
        for (const table of moved) {
          table.x = Math.min(table.x, area.width);
          table.y = Math.min(table.y, area.height);
        }
        if (moved.length) await tableRepo.save(moved);
      }
      return area;
    });

    this.gatewayService.notifyTablesUpdated(organizationId, [area.id]);
    return area;
  }

  async reorderAreas(
    organizationId: string,
    dto: ReorderTableAreasDto,
    user: User,
  ): Promise<TableArea[]> {
    await this.checkWritePermission(organizationId, user.id);

    const areas = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(TableArea);
      const areas = await repo.find({ where: { organizationId } });
      const byId = new Map(areas.map((a) => [a.id, a]));
      const missing = dto.ids.find((id) => !byId.has(id));
      if (missing) throw this.areaNotFound();

      const ordered = dto.ids.map((id, index) => {
        const area = byId.get(id)!;
        area.sortOrder = index;
        return area;
      });
      // Nicht genannte Bereiche hinten anstellen, Reihenfolge beibehalten.
      const rest = areas
        .filter((a) => !dto.ids.includes(a.id))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      rest.forEach((area, i) => (area.sortOrder = ordered.length + i));

      await repo.save([...ordered, ...rest]);
      return [...ordered, ...rest];
    });

    this.gatewayService.notifyTablesUpdated(organizationId);
    return areas;
  }

  async removeArea(
    organizationId: string,
    areaId: string,
    user: User,
  ): Promise<void> {
    await this.checkWritePermission(organizationId, user.id);

    await this.dataSource.transaction(async (manager) => {
      const area = await this.getArea(manager, organizationId, areaId);
      const tableRepo = manager.getRepository(DiningTable);
      const tables = await tableRepo.find({
        where: { organizationId, areaId: area.id },
      });
      await this.assertNoOpenOrders(
        manager,
        tables.map((t) => t.id),
      );
      if (tables.length) {
        await tableRepo.softDelete({ id: In(tables.map((t) => t.id)) });
      }
      await manager.getRepository(TableArea).softDelete({ id: area.id });
    });

    this.logger.log(`Table area deleted: ${areaId}`);
    this.gatewayService.notifyTablesUpdated(organizationId);
  }

  /**
   * Speichert die Karte eines Bereichs (Autosave des Editors) in einer
   * Transaktion. Alle genannten Tische muessen zum Bereich gehoeren.
   */
  async putLayout(
    organizationId: string,
    areaId: string,
    dto: PutTableAreaLayoutDto,
    user: User,
  ): Promise<TableAreaWithTables> {
    await this.checkWritePermission(organizationId, user.id);

    const area = await this.dataSource.transaction(async (manager) => {
      const area = await this.getArea(manager, organizationId, areaId);
      const tableRepo = manager.getRepository(DiningTable);
      const tables = await tableRepo.find({
        where: { organizationId, areaId: area.id },
      });
      const byId = new Map(tables.map((t) => [t.id, t]));

      const changed: DiningTable[] = [];
      for (const item of dto.tables) {
        const table = byId.get(item.id);
        if (!table) throw this.tableNotFound(item.id);
        this.assertInArea(area, item.x, item.y);
        table.x = item.x;
        table.y = item.y;
        table.width = item.width;
        table.height = item.height;
        table.rotation = item.rotation;
        if (item.shape) table.shape = item.shape;
        changed.push(table);
      }
      if (changed.length) await tableRepo.save(changed);

      if (dto.decor || dto.outline !== undefined) {
        this.applyShapes(area, dto);
        await manager.getRepository(TableArea).save(area);
      }

      return Object.assign(area, {
        tables: tables.sort(
          (a, b) =>
            a.sortOrder - b.sortOrder || naturalCompare(a.label, b.label),
        ),
      });
    });

    this.gatewayService.notifyTablesUpdated(organizationId, [area.id]);
    return area;
  }

  // ---------------------------------------------------------------------
  // Tische

  async createTable(
    organizationId: string,
    dto: CreateDiningTableDto,
    user: User,
  ): Promise<DiningTable> {
    await this.checkWritePermission(organizationId, user.id);

    const table = await this.dataSource.transaction(async (manager) => {
      const area = await this.getArea(manager, organizationId, dto.areaId);
      const repo = manager.getRepository(DiningTable);
      const existing = await repo.find({ where: { organizationId } });
      this.assertLabelsFree(existing, [dto.label]);

      const x = dto.x ?? 0;
      const y = dto.y ?? 0;
      this.assertInArea(area, x, y);

      const table = repo.create({
        organizationId,
        areaId: area.id,
        label: dto.label,
        seats: dto.seats ?? null,
        shape: dto.shape ?? DiningTableShape.RECT,
        x,
        y,
        width: dto.width ?? DEFAULT_TABLE_SIZE,
        height: dto.height ?? DEFAULT_TABLE_SIZE,
        rotation: dto.rotation ?? 0,
        sortOrder: this.nextSortOrder(existing, area.id),
        isActive: true,
      });
      await this.saveTables(manager, [table], [dto.label]);
      return table;
    });

    this.logger.log(`Table created: ${table.label} (${table.id})`);
    this.gatewayService.notifyTablesUpdated(organizationId, [table.areaId]);
    return table;
  }

  /**
   * Serie anlegen, z. B. A01–A12. Gibt es eine der Bezeichnungen schon,
   * wird nichts angelegt (409 mit allen Kollisionen).
   */
  async bulkCreate(
    organizationId: string,
    dto: BulkCreateDiningTablesDto,
    user: User,
  ): Promise<DiningTable[]> {
    await this.checkWritePermission(organizationId, user.id);

    const labels = bulkLabels(dto.prefix, dto.start, dto.count, dto.padding);
    const tooLong = labels.find((l) => l.length > LABEL_MAX);
    if (tooLong) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TABLE_LABEL_INVALID,
        message: `Die Tischbezeichnung „${tooLong}“ ist länger als ${LABEL_MAX} Zeichen`,
        params: { label: tooLong, max: LABEL_MAX },
      });
    }

    const tables = await this.dataSource.transaction(async (manager) => {
      const area = await this.getArea(manager, organizationId, dto.areaId);
      const repo = manager.getRepository(DiningTable);
      const existing = await repo.find({ where: { organizationId } });
      this.assertLabelsFree(existing, labels);

      const inArea = existing.filter((t) => t.areaId === area.id);
      const firstSort = this.nextSortOrder(existing, area.id);
      const size = DEFAULT_TABLE_SIZE;
      const layout = dto.layout;
      // Neue Reihe unter den vorhandenen Tischen des Bereichs beginnen.
      const originY = layout
        ? inArea.length
          ? Math.max(...inArea.map((t) => t.y + t.height)) + layout.gap
          : layout.gap
        : 0;

      const created = labels.map((label, i) => {
        let x = 0;
        let y = 0;
        if (layout) {
          const col = i % layout.cols;
          const row = Math.floor(i / layout.cols);
          x = Math.min(layout.gap + col * (size + layout.gap), area.width);
          y = Math.min(originY + row * (size + layout.gap), area.height);
        }
        return repo.create({
          organizationId,
          areaId: area.id,
          label,
          seats: dto.seats ?? null,
          shape: dto.shape ?? DiningTableShape.RECT,
          x,
          y,
          width: size,
          height: size,
          rotation: 0,
          sortOrder: firstSort + i,
          isActive: true,
        });
      });
      await this.saveTables(manager, created, labels);
      return created;
    });

    this.logger.log(
      `Tables created: ${labels[0]}…${labels[labels.length - 1]} (${tables.length})`,
    );
    this.gatewayService.notifyTablesUpdated(organizationId, [dto.areaId]);
    return tables;
  }

  async updateTable(
    organizationId: string,
    tableId: string,
    dto: UpdateDiningTableDto,
    user: User,
  ): Promise<DiningTable> {
    await this.checkWritePermission(organizationId, user.id);

    let previousAreaId = '';
    const table = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DiningTable);
      const table = await this.getTable(manager, organizationId, tableId);
      previousAreaId = table.areaId;

      const area =
        dto.areaId != null && dto.areaId !== table.areaId
          ? await this.getArea(manager, organizationId, dto.areaId)
          : await this.getArea(manager, organizationId, table.areaId);

      const renamed =
        dto.label != null && dto.label !== table.label ? dto.label : null;
      if (renamed && tableKey(renamed) !== tableKey(table.label)) {
        const existing = await repo.find({ where: { organizationId } });
        this.assertLabelsFree(
          existing.filter((t) => t.id !== table.id),
          [renamed],
        );
      }

      if (area.id !== table.areaId) {
        table.areaId = area.id;
        table.sortOrder = this.nextSortOrder(
          await repo.find({ where: { organizationId, areaId: area.id } }),
          area.id,
        );
      }
      if (renamed) table.label = renamed;
      if (dto.seats !== undefined) table.seats = dto.seats ?? null;
      if (dto.shape != null) table.shape = dto.shape;
      if (dto.width != null) table.width = dto.width;
      if (dto.height != null) table.height = dto.height;
      if (dto.rotation != null) table.rotation = dto.rotation;
      if (dto.isActive != null) table.isActive = dto.isActive;
      if (dto.x != null || dto.y != null) {
        const x = dto.x ?? table.x;
        const y = dto.y ?? table.y;
        this.assertInArea(area, x, y);
        table.x = x;
        table.y = y;
      } else {
        table.x = Math.min(table.x, area.width);
        table.y = Math.min(table.y, area.height);
      }

      await this.saveTables(manager, [table], [table.label]);

      if (renamed) {
        // Offene Bestellungen tragen die neue Bezeichnung, bezahlte behalten
        // ihren Snapshot (Bons, Berichte).
        await manager
          .getRepository(Order)
          .update(
            { tableId: table.id, ...OPEN_ORDER_WHERE },
            { tableNumber: renamed },
          );
      }
      return table;
    });

    this.gatewayService.notifyTablesUpdated(
      organizationId,
      [...new Set([previousAreaId, table.areaId])].filter(Boolean),
    );
    return table;
  }

  async removeTable(
    organizationId: string,
    tableId: string,
    user: User,
  ): Promise<void> {
    await this.checkWritePermission(organizationId, user.id);

    const table = await this.dataSource.transaction(async (manager) => {
      const table = await this.getTable(manager, organizationId, tableId);
      await this.assertNoOpenOrders(manager, [table.id]);
      await manager.getRepository(DiningTable).softDelete({ id: table.id });
      return table;
    });

    this.logger.log(`Table deleted: ${table.label} (${table.id})`);
    this.gatewayService.notifyTablesUpdated(organizationId, [table.areaId]);
  }

  // ---------------------------------------------------------------------
  // Hilfen

  private async getArea(
    manager: EntityManager,
    organizationId: string,
    areaId: string,
  ): Promise<TableArea> {
    const area = await manager
      .getRepository(TableArea)
      .findOne({ where: { id: areaId, organizationId } });
    if (!area) throw this.areaNotFound();
    return area;
  }

  private async getTable(
    manager: EntityManager,
    organizationId: string,
    tableId: string,
  ): Promise<DiningTable> {
    const table = await manager
      .getRepository(DiningTable)
      .findOne({ where: { id: tableId, organizationId } });
    if (!table) throw this.tableNotFound(tableId);
    return table;
  }

  private nextSortOrder(tables: DiningTable[], areaId: string): number {
    return (
      tables
        .filter((t) => t.areaId === areaId)
        .reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1
    );
  }

  private assertAreaNameFree(areas: TableArea[], name: string): void {
    const wanted = name.trim().toLowerCase();
    if (areas.some((a) => a.name.trim().toLowerCase() === wanted)) {
      throw this.areaNameTaken(name);
    }
  }

  /** Bezeichnungen sind org-weit eindeutig, gross/klein egal. */
  private assertLabelsFree(existing: DiningTable[], labels: string[]): void {
    const taken = new Set(existing.map((t) => tableKey(t.label)));
    const conflicts = labels.filter((l) => taken.has(tableKey(l)));
    if (conflicts.length) throw this.labelsTaken(conflicts);
  }

  private assertInArea(area: TableArea, x: number, y: number): void {
    if (x < 0 || y < 0 || x > area.width || y > area.height) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        reason: ErrorReasons.TABLE_OUT_OF_AREA,
        message: `Die Position liegt außerhalb des Bereichs (${area.width} × ${area.height})`,
        params: { width: area.width, height: area.height, x, y },
      });
    }
  }

  /**
   * Uebernimmt Deko (Rechtecke, Waende als Linienzug, Zonen) und Umriss
   * nach Pruefung; `outline: null` setzt den Umriss zurueck (ganze Karte).
   */
  private applyShapes(
    area: TableArea,
    dto: { decor?: TableAreaDecorDto[]; outline?: TableAreaPointDto[] | null },
  ): void {
    if (dto.decor) {
      this.assertDecorInArea(area, dto.decor);
      area.decor = dto.decor.map((d) => this.toDecor(d));
    }
    if (dto.outline !== undefined) {
      if (dto.outline) {
        this.assertPoints(area, dto.outline, POLYGON_POINTS_MIN, 'outline');
      }
      area.outline = dto.outline?.length
        ? dto.outline.map((p) => ({ x: p.x, y: p.y }))
        : null;
    }
  }

  private assertDecorInArea(area: TableArea, decor: TableAreaDecorDto[]) {
    for (const item of decor) {
      if (isShapeDecor(item)) {
        const zone = item.type === 'zone';
        if (zone && !item.zoneType) throw this.shapeInvalid('zone', 'type');
        this.assertPoints(
          area,
          item.points,
          zone ? POLYGON_POINTS_MIN : LINE_POINTS_MIN,
          zone ? 'zone' : 'wall',
        );
      } else {
        if (
          [item.x, item.y, item.width, item.height, item.rotation].some(
            (v) => typeof v !== 'number',
          )
        ) {
          throw this.shapeInvalid('decor', 'rect');
        }
        this.assertInArea(area, item.x!, item.y!);
      }
    }
  }

  /** Punkte einer Form: Anzahl in Grenzen, jeder Punkt innerhalb der Karte. */
  private assertPoints(
    area: TableArea,
    points: TableAreaPointDto[] | undefined,
    min: number,
    kind: 'outline' | 'wall' | 'zone',
  ): void {
    if (!Array.isArray(points) || points.length < min) {
      throw this.shapeInvalid(kind, 'tooFewPoints', { min });
    }
    if (points.length > SHAPE_POINTS_MAX) {
      throw this.shapeInvalid(kind, 'tooManyPoints', { max: SHAPE_POINTS_MAX });
    }
    for (const p of points) this.assertInArea(area, p.x, p.y);
  }

  private shapeInvalid(
    kind: 'outline' | 'wall' | 'zone' | 'decor',
    problem: 'tooFewPoints' | 'tooManyPoints' | 'type' | 'rect',
    params: Record<string, number> = {},
  ): BadRequestException {
    const what = {
      outline: 'Die Raumform',
      wall: 'Eine Wand',
      zone: 'Eine Zone',
      decor: 'Ein Deko-Element',
    }[kind];
    const message = {
      tooFewPoints: `${what} braucht mindestens ${params.min} Punkte`,
      tooManyPoints: `${what} darf höchstens ${params.max} Punkte haben`,
      type: 'Wähle einen Zonentyp: Küche, Gesperrt, Bar/Theke oder Sonstiges',
      rect: `${what} braucht Position, Größe und Drehung`,
    }[problem];
    return new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      reason: ErrorReasons.TABLE_AREA_SHAPE_INVALID,
      message,
      params: { kind, problem, ...params },
    });
  }

  /** Nach Verkleinern der Karte: Punkte an den neuen Rand ziehen. */
  private clampShapes(area: TableArea): void {
    const clamp = (p: TableAreaPoint): TableAreaPoint => ({
      x: Math.min(Math.max(p.x, 0), area.width),
      y: Math.min(Math.max(p.y, 0), area.height),
    });
    if (area.outline) area.outline = area.outline.map(clamp);
    area.decor = (area.decor ?? []).map((d) =>
      'points' in d && Array.isArray(d.points)
        ? { ...d, points: d.points.map(clamp) }
        : d,
    );
  }

  private toDecor(d: TableAreaDecorDto): TableAreaDecor {
    const label = d.label ? { label: d.label } : {};
    const points = (d.points ?? []).map((p) => ({ x: p.x, y: p.y }));
    if (d.type === 'zone') {
      return {
        id: d.id,
        type: 'zone',
        zoneType: d.zoneType!,
        points,
        ...label,
      };
    }
    if (isShapeDecor(d)) {
      return {
        id: d.id,
        type: 'wall',
        points,
        ...(d.thickness ? { thickness: d.thickness } : {}),
      };
    }
    return {
      id: d.id,
      type: d.type,
      x: d.x!,
      y: d.y!,
      width: d.width!,
      height: d.height!,
      rotation: d.rotation!,
      ...label,
    };
  }

  private async assertNoOpenOrders(
    manager: EntityManager,
    tableIds: string[],
  ): Promise<void> {
    if (tableIds.length === 0) return;
    const count = await manager.getRepository(Order).count({
      where: { tableId: In(tableIds), ...OPEN_ORDER_WHERE },
    });
    if (count > 0) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        reason: ErrorReasons.TABLE_HAS_OPEN_ORDERS,
        message:
          count === 1
            ? 'An diesem Tisch ist noch eine Bestellung offen. Kassiere sie zuerst ab.'
            : `An ${tableIds.length === 1 ? 'diesem Tisch' : 'diesen Tischen'} sind noch ${count} Bestellungen offen. Kassiere sie zuerst ab.`,
        params: { count },
      });
    }
  }

  private async saveArea(manager: EntityManager, area: TableArea) {
    try {
      await manager.getRepository(TableArea).save(area);
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_table_areas_org_name')) {
        throw this.areaNameTaken(area.name);
      }
      throw error;
    }
  }

  private async saveTables(
    manager: EntityManager,
    tables: DiningTable[],
    labels: string[],
  ) {
    try {
      await manager.getRepository(DiningTable).save(tables);
    } catch (error) {
      // Gleichzeitig angelegt: der Index faengt, was die Pruefung nicht sah.
      if (isUniqueViolation(error, 'UQ_dining_tables_org_label')) {
        throw this.labelsTaken(labels);
      }
      throw error;
    }
  }

  private areaNotFound() {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.TABLE_AREA_NOT_FOUND,
      message: 'Bereich nicht gefunden',
    });
  }

  private tableNotFound(tableId: string) {
    return new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      reason: ErrorReasons.TABLE_NOT_FOUND,
      message: 'Tisch nicht gefunden',
      params: { tableId },
    });
  }

  private areaNameTaken(name: string) {
    return new ConflictException({
      code: ErrorCodes.CONFLICT,
      reason: ErrorReasons.TABLE_AREA_NAME_TAKEN,
      message: `Einen Bereich „${name}“ gibt es schon`,
      params: { name },
    });
  }

  /**
   * 409 mit allen kollidierenden Bezeichnungen: `params.conflicts` als
   * Komma-Liste, `details[]` je Bezeichnung (Feld `label`, Text = Bezeichnung).
   */
  private labelsTaken(conflicts: string[]) {
    return new ConflictException({
      code: ErrorCodes.CONFLICT,
      reason: ErrorReasons.TABLE_LABEL_TAKEN,
      message:
        conflicts.length === 1
          ? `Einen Tisch „${conflicts[0]}“ gibt es schon`
          : `Diese Tische gibt es schon: ${conflicts.join(', ')}`,
      params: {
        label: conflicts[0],
        conflicts: conflicts.join(', '),
        count: conflicts.length,
      },
      details: conflicts.map((label) => ({
        field: 'label',
        code: ErrorReasons.TABLE_LABEL_TAKEN,
        message: label,
      })),
    });
  }

  private async checkMembership(
    organizationId: string,
    userId: string,
  ): Promise<UserOrganization> {
    const membership = await this.dataSource
      .getRepository(UserOrganization)
      .findOne({ where: { organizationId, userId } });

    if (!membership) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.ORGANIZATION_ACCESS_DENIED,
        message: 'Kein Zugriff auf diese Organisation',
      });
    }
    return membership;
  }

  /** Schreiben: Admins oder Mitglieder mit Veranstaltungsrecht. */
  private async checkWritePermission(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.checkMembership(organizationId, userId);
    if (
      membership.role !== OrganizationRole.ADMIN &&
      !membership.permissions?.events
    ) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        reason: ErrorReasons.INSUFFICIENT_PERMISSIONS,
        message: 'Keine ausreichenden Berechtigungen',
      });
    }
  }
}
