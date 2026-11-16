import { User } from '../../database/entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

interface Session {
  id: string;
  userId: string;
  revokedAt: Date | null;
}

/** Refresh-Tokens im Speicher mit dem Ausschnitt des QueryBuilders, den
 *  changePassword benutzt. */
function fakeSessions(rows: Session[]) {
  return {
    rows,
    createQueryBuilder() {
      const filters: Array<(row: Session) => boolean> = [];
      let changes: Partial<Session> = {};
      const builder = {
        update: () => builder,
        set: (c: Partial<Session>) => {
          changes = c;
          return builder;
        },
        where: (_sql: string, params: { userId: string }) => {
          filters.push((r) => r.userId === params.userId && !r.revokedAt);
          return builder;
        },
        andWhere: (_sql: string, params: { currentSessionId: string }) => {
          filters.push((r) => r.id !== params.currentSessionId);
          return builder;
        },
        execute: () => {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          for (const row of hit) Object.assign(row, changes);
          return Promise.resolve({ affected: hit.length });
        },
      };
      return builder;
    },
  };
}

function setup() {
  const sessions = fakeSessions([
    { id: 'current', userId: 'user-1', revokedAt: null },
    { id: 'phone', userId: 'user-1', revokedAt: null },
    { id: 'laptop', userId: 'user-1', revokedAt: null },
    { id: 'someone-else', userId: 'user-2', revokedAt: null },
  ]);
  const stored = { id: 'user-1', email: 'a@b.de', passwordHash: null };
  const userRepository = {
    findOne: jest.fn(() => Promise.resolve(stored)),
    save: jest.fn((u: unknown) => Promise.resolve(u)),
  };
  const none = {} as never;
  const service = new AuthService(
    userRepository as never,
    none,
    none,
    sessions as never,
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
  const active = () =>
    sessions.rows.filter((r) => !r.revokedAt).map((r) => r.id);
  return { service, active };
}

describe('password change', () => {
  it('ends the other sessions and keeps the current one', async () => {
    const { service, active } = setup();
    await service.changePassword(
      'user-1',
      { currentPassword: '', newPassword: 'Neues-Passwort-1' },
      'current',
    );
    expect(active()).toEqual(['current', 'someone-else']);
  });

  it('ends all sessions when the current one is unknown', async () => {
    const { service, active } = setup();
    await service.changePassword(
      'user-1',
      { currentPassword: '', newPassword: 'Neues-Passwort-1' },
      null,
    );
    expect(active()).toEqual(['someone-else']);
  });

  it('passes the session of the access token from the controller', async () => {
    const changePassword = jest.fn(() => Promise.resolve());
    const controller = new AuthController(
      { changePassword } as never,
      ...(Array.from({ length: 12 }, () => ({})) as never[]),
    );
    await controller.changePassword(
      { id: 'user-1' } as User,
      { currentPassword: 'alt', newPassword: 'Neues-Passwort-1' },
      'current',
    );
    expect(changePassword).toHaveBeenCalledWith(
      'user-1',
      { currentPassword: 'alt', newPassword: 'Neues-Passwort-1' },
      'current',
    );
  });
});
