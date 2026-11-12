import {
  BadRequestException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Repository } from 'typeorm';

import { OnlineOrderSession } from '../../database/entities/online-order-session.entity';
import { QrCode, QrCodeType } from '../../database/entities/qr-code.entity';
import { HttpExceptionFilter } from '../../common/filters';
import { validationException } from '../../common/pipes/validation.pipe';
import { DeploymentService } from '../../common/services/deployment.service';
import { OnlineOrdersController } from './online-orders.controller';
import { OnlineOrdersService } from './online-orders.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const EVENT = '9c9c9c9c-4f43-4a3e-9f8e-0f2b8f3f1a33';

/**
 * Bestellen am Tisch beginnt mit dem Scan eines QR-Codes. Eine Sitzung nur
 * mit `organizationId` endete in einem 500 (qr_code_id ist NOT NULL) —
 * jetzt 400 QR_CODE_REQUIRED, ohne dass etwas gespeichert wird.
 */
function setup(qr: Partial<QrCode> | null) {
  const saved: OnlineOrderSession[] = [];
  const saveSession = jest.fn((s: OnlineOrderSession) => {
    saved.push({ ...s } as OnlineOrderSession);
    return Promise.resolve(Object.assign(s, { id: 'session-1' }));
  });
  const sessionRepository = {
    create: (data: Partial<OnlineOrderSession>) =>
      Object.assign(new OnlineOrderSession(), data),
    save: saveSession,
  } as unknown as Repository<OnlineOrderSession>;
  const findQr = jest.fn(() => Promise.resolve(qr ? { ...qr } : null));
  const saveQr = jest.fn((q: QrCode) => Promise.resolve(q));
  const qrCodeRepository = {
    findOne: findQr,
    save: saveQr,
  } as unknown as Repository<QrCode>;
  const none = undefined as never;
  const service = new OnlineOrdersService(
    sessionRepository,
    qrCodeRepository,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
  );
  return { service, saveSession, findQr, saveQr, saved };
}

const tableQr: Partial<QrCode> = {
  id: 'qr-1',
  code: 'TISCH12',
  type: QrCodeType.TABLE,
  organizationId: ORG,
  eventId: EVENT,
  tableNumber: '12',
  isActive: true,
  scanCount: 4,
  organization: { id: ORG, name: 'TSV Musterstadt' } as QrCode['organization'],
  event: {
    id: EVENT,
    organizationId: ORG,
    name: 'Sommerfest',
  } as QrCode['event'],
};

function reason(error: unknown): string | undefined {
  return ((error as BadRequestException).getResponse() as { reason?: string })
    .reason;
}

describe('OnlineOrdersService.startSession', () => {
  it.each([
    ['only an organization', { organizationId: ORG }],
    ['organization and event', { organizationId: ORG, eventId: EVENT }],
    ['nothing', {}],
    ['a blank code', { code: '   ' }],
  ])('refuses a session with %s: 400 QR_CODE_REQUIRED', async (_l, dto) => {
    const { service, saveSession, findQr } = setup(tableQr);
    const error: unknown = await service
      .startSession(dto)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(reason(error)).toBe('QR_CODE_REQUIRED');
    expect(findQr).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('starts a session from a table QR code: organization, event and table from the code', async () => {
    const { service, saveQr, saved } = setup(tableQr);
    const { sessionToken, session } = await service.startSession({
      code: 'TISCH12',
      // Ignoriert: der QR-Code bestimmt Organisation und Tisch.
      organizationId: '1b1b1b1b-4f43-4a3e-9f8e-0f2b8f3f1a22',
      tableNumber: '99',
    });
    expect(sessionToken).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(saved[0]).toMatchObject({
      organizationId: ORG,
      eventId: EVENT,
      qrCodeId: 'qr-1',
      tableNumber: '12',
      status: 'active',
    });
    expect(saveQr).toHaveBeenCalledWith(
      expect.objectContaining({ scanCount: 5 }),
    );
    // Fuer eventName/organizationName in der Antwort.
    expect(session.event?.name).toBe('Sommerfest');
    expect(session.organization.name).toBe('TSV Musterstadt');
  });

  it('takes the guest table number when the QR code has none', async () => {
    const { service, saved } = setup({
      ...tableQr,
      type: QrCodeType.EVENT,
      tableNumber: null,
    });
    await service.startSession({ code: 'TISCH12', tableNumber: '7' });
    expect(saved[0].tableNumber).toBe('7');
  });

  it('ignores an event of another organization linked to the QR code', async () => {
    const { service, saved } = setup({
      ...tableQr,
      event: {
        id: EVENT,
        organizationId: 'f0f0f0f0-4f43-4a3e-9f8e-0f2b8f3f1a99',
        name: 'Anderes Fest',
      } as QrCode['event'],
    });
    const { session } = await service.startSession({ code: 'TISCH12' });
    expect(saved[0].eventId).toBeNull();
    expect(session.event).toBeNull();
  });

  it('answers 404 QR_CODE_NOT_FOUND for an unknown or inactive code', async () => {
    const { service, saveSession } = setup(null);
    const error: unknown = await service
      .startSession({ code: 'NOPE' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(reason(error)).toBe('QR_CODE_NOT_FOUND');
    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe('POST /public/order/session over HTTP', () => {
  let app: INestApplication<App>;
  const { service } = setup(tableQr);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OnlineOrdersController],
      providers: [
        { provide: OnlineOrdersService, useValue: service },
        { provide: DeploymentService, useValue: { platformLegal: null } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Wie in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: validationException,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('only organizationId: 400 with reason QR_CODE_REQUIRED (was 500)', async () => {
    const res = await request(app.getHttpServer())
      .post('/public/order/session')
      .send({ organizationId: ORG })
      .expect(400);
    expect(res.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', reason: 'QR_CODE_REQUIRED' },
    });
  });

  it('with a QR code: session plus event and organization name', async () => {
    const res = await request(app.getHttpServer())
      .post('/public/order/session')
      .send({ code: 'TISCH12' })
      .expect(201);
    expect(res.body).toMatchObject({
      data: {
        eventName: 'Sommerfest',
        organizationName: 'TSV Musterstadt',
        session: { tableNumber: '12', status: 'active' },
      },
    });
  });
});
