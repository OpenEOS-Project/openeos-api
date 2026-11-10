import * as bcrypt from 'bcrypt';
import { assertCurrentPassword } from './current-password';

describe('assertCurrentPassword', () => {
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash('Geheim123', 4);
  });

  it('lets accounts without a password through without asking', async () => {
    await expect(assertCurrentPassword(null, undefined)).resolves.toBe(
      undefined,
    );
    await expect(assertCurrentPassword(null, 'egal')).resolves.toBe(undefined);
  });

  it('requires the current password when the account has one', async () => {
    await expect(assertCurrentPassword(hash, undefined)).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        reason: 'CURRENT_PASSWORD_REQUIRED',
      },
    });
    await expect(assertCurrentPassword(hash, '')).rejects.toMatchObject({
      response: { reason: 'CURRENT_PASSWORD_REQUIRED' },
    });
  });

  it('rejects a wrong password and accepts the right one', async () => {
    await expect(
      assertCurrentPassword(hash, 'Falsch123'),
    ).rejects.toMatchObject({ response: { reason: 'PASSWORD_INCORRECT' } });
    await expect(assertCurrentPassword(hash, 'Geheim123')).resolves.toBe(
      undefined,
    );
  });
});
