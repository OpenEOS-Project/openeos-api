import { HttpException } from '@nestjs/common';

import { ContentReportsService } from './content-reports.service';
import {
  defaultRedress,
  parseReportTarget,
  statementRows,
} from './content-report.util';
import type { CreateContentReportDto } from './dto';

const EVENT = '3f1c2a7e-9b1d-4c55-8a0e-2d6f8b7c9e01';

describe('parseReportTarget', () => {
  it('recognizes shop pages, withdrawal pages and helper pages', () => {
    expect(parseReportTarget(`https://shop.openeos.de/${EVENT}`)).toEqual({
      kind: 'event',
      eventId: EVENT,
    });
    expect(
      parseReportTarget(`https://shop.openeos.de/${EVENT}/checkout?x=1`),
    ).toEqual({ kind: 'event', eventId: EVENT });
    expect(
      parseReportTarget(`https://shop.openeos.de/widerruf/${EVENT}`),
    ).toEqual({ kind: 'event', eventId: EVENT });
    expect(parseReportTarget('https://app.openeos.de/s/sommerfest')).toEqual({
      kind: 'shift_plan',
      slug: 'sommerfest',
    });
    expect(
      parseReportTarget('https://app.openeos.de/en/s/sommerfest/legal/imprint'),
    ).toEqual({ kind: 'shift_plan', slug: 'sommerfest' });
  });

  it('returns null for everything else', () => {
    expect(parseReportTarget('kein link')).toBeNull();
    expect(parseReportTarget('https://app.openeos.de/s/manage/abc')).toBeNull();
    expect(parseReportTarget('https://openeos.de/agb')).toBeNull();
    expect(parseReportTarget('https://shop.openeos.de/')).toBeNull();
  });
});

describe('statementRows', () => {
  it('names action, facts, ground, the human decision and redress', () => {
    const rows = statementRows({
      action: 'disable_shop',
      decision: 'Inhalt rechtswidrig',
      facts: 'Verkauf von Alkohol an Minderjährige beworben',
      ground: 'AGB Ziffer 6.7; § 9 JuSchG',
      redress: defaultRedress('hello@openeos.de'),
      url: 'https://shop.openeos.de/x',
      reportedAt: new Date('2026-11-12T10:00:00Z'),
    });
    const labels = rows.map(([label]) => label);
    expect(labels).toEqual([
      'Gemeldete Fundstelle',
      'Eingang der Meldung',
      'Entscheidung',
      'Maßnahme',
      'Sachverhalt',
      'Rechtliche bzw. vertragliche Grundlage',
      'Automatisierte Mittel',
      'Rechtsbehelfe',
    ]);
    expect(rows[3][1]).toMatch(/Seite wurde gesperrt/);
    expect(rows[7][1]).toContain('hello@openeos.de');
  });
});

function dto(
  over: Partial<CreateContentReportDto> = {},
): CreateContentReportDto {
  return {
    url: `https://shop.openeos.de/${EVENT}`,
    reason: 'illegal',
    description: 'Hier wird etwas Rechtswidriges angeboten, bitte prüfen.',
    name: 'Erika Muster',
    email: 'Erika@Example.test',
    goodFaith: true,
    startedAt: Date.now() - 60_000,
    ...over,
  };
}

function setup(opts: { counts?: number[]; events?: unknown[] } = {}) {
  const saved: Record<string, unknown>[] = [];
  const counts = [...(opts.counts ?? [0, 0])];
  const repo = {
    count: jest.fn(() => Promise.resolve(counts.shift() ?? 0)),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) => {
      const row = { id: 'r1', createdAt: new Date(), ...v };
      saved.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({})),
    findOne: jest.fn(),
  };
  const dataSource = {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM events')) {
        return Promise.resolve(
          opts.events ?? [{ id: EVENT, organization_id: 'o1' }],
        );
      }
      return Promise.resolve([]);
    }),
  };
  const email = {
    sendContentReportReceipt: jest.fn(() => Promise.resolve(true)),
    sendAdminContentReportNotification: jest.fn(() => Promise.resolve(true)),
    sendContentReportDecision: jest.fn(() => Promise.resolve(true)),
  };
  const platform = {
    resolvePlatformAdminEmail: jest.fn(() =>
      Promise.resolve('ops@example.test'),
    ),
  };
  const deployment = {
    platformLegal: {
      imprintUrl: null,
      privacyUrl: null,
      contactEmail: 'hello@openeos.de',
      reportUrl: null,
    },
  };
  const service = new ContentReportsService(
    repo as never,
    dataSource as never,
    email as never,
    platform as never,
    deployment as never,
  );
  return { service, repo, email, saved, dataSource };
}

describe('ContentReportsService.submit', () => {
  it('stores the report with the resolved club, confirms receipt and notifies the operator', async () => {
    const { service, saved, email } = setup();
    await service.submit(dto());
    expect(saved[0]).toMatchObject({
      reporterEmail: 'erika@example.test',
      targetType: 'shop',
      organizationId: 'o1',
      eventId: EVENT,
      goodFaith: true,
      status: 'open',
    });
    expect(email.sendContentReportReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'erika@example.test' }),
    );
    expect(email.sendAdminContentReportNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.test',
        adminPath: '/admin/reports?id=r1',
      }),
    );
  });

  it('silently drops honeypot hits, too-fast submissions and duplicates', async () => {
    const honeypot = setup();
    await honeypot.service.submit(dto({ website: 'spam' }));
    const fast = setup();
    await fast.service.submit(dto({ startedAt: Date.now() }));
    const duplicate = setup({ counts: [1] });
    await duplicate.service.submit(dto());
    for (const s of [honeypot, fast, duplicate]) {
      expect(s.saved).toHaveLength(0);
      expect(s.email.sendContentReportReceipt).not.toHaveBeenCalled();
    }
  });

  it('pauses after the daily limit and points to the contact address', async () => {
    const { service, saved } = setup({ counts: [0, 200] });
    await expect(service.submit(dto())).rejects.toThrow(HttpException);
    expect(saved).toHaveLength(0);
  });

  it('keeps reports for unknown pages', async () => {
    const { service, saved } = setup({ events: [] });
    await service.submit(dto({ url: 'https://example.org/irgendwas' }));
    expect(saved[0]).toMatchObject({
      targetType: 'unknown',
      organizationId: null,
    });
  });
});

describe('ContentReportsService.update', () => {
  it('disables the shop once and closes the report', async () => {
    const { service, repo, dataSource } = setup();
    const report = {
      id: 'r1',
      createdAt: new Date(),
      url: 'https://shop.openeos.de/x',
      eventId: EVENT,
      shiftPlanId: null,
      organizationId: 'o1',
      status: 'open',
      action: null,
      actionAppliedAt: null,
      closedAt: null,
      redress: null,
    };
    repo.findOne.mockResolvedValue(report);
    repo.save.mockImplementation((v: Record<string, unknown>) =>
      Promise.resolve(v),
    );
    await service.update(
      'r1',
      { status: 'closed', action: 'disable_shop', ground: ' AGB 6.7 ' },
      'admin',
    );
    expect(report).toMatchObject({
      status: 'closed',
      ground: 'AGB 6.7',
      handledBy: 'admin',
    });
    expect(report.closedAt).toBeInstanceOf(Date);
    expect(report.actionAppliedAt).toBeInstanceOf(Date);
    const updates = dataSource.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith('UPDATE events'),
    );
    expect(updates).toHaveLength(1);

    await service.update('r1', { action: 'disable_shop' }, 'admin');
    expect(
      dataSource.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('UPDATE events'),
      ),
    ).toHaveLength(1);
  });
});
