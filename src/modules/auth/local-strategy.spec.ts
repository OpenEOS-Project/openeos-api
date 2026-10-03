import { UnauthorizedException } from '@nestjs/common';

import { ErrorCodes } from '../../common/constants/error-codes';
import { User } from '../../database/entities';
import { AuthService } from './auth.service';
import { LocalStrategy } from './strategies/local.strategy';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/**
 * Falsche Anmeldedaten kommen mit INVALID_CREDENTIALS zurueck, damit die
 * Oberflaeche die Meldung uebersetzen kann.
 */
describe('LocalStrategy.validate', () => {
  function strategy(result: User | null) {
    const validateUser = jest.fn(() => Promise.resolve(result));
    const authService = { validateUser } as unknown as AuthService;
    return { strategy: new LocalStrategy(authService), validateUser };
  }

  it('rejects bad credentials with INVALID_CREDENTIALS', async () => {
    const { strategy: local } = strategy(null);

    const error = await local
      .validate('someone@example.org', 'wrong')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: ErrorCodes.INVALID_CREDENTIALS,
      message: 'Falsche E-Mail oder Passwort',
    });
  });

  it('passes errors from validateUser (e.g. ACCOUNT_LOCKED) through unchanged', async () => {
    const locked = new UnauthorizedException({
      code: ErrorCodes.ACCOUNT_LOCKED,
      message: 'Konto ist für 5 Minuten gesperrt',
    });
    const validateUser = jest.fn(() => Promise.reject(locked));
    const local = new LocalStrategy({
      validateUser,
    } as unknown as AuthService);

    await expect(local.validate('a@b.de', 'x')).rejects.toBe(locked);
  });

  it('returns the user on success', async () => {
    const user = { id: 'u1' } as User;
    const { strategy: local, validateUser } = strategy(user);

    await expect(local.validate('a@b.de', 'right')).resolves.toBe(user);
    expect(validateUser).toHaveBeenCalledWith('a@b.de', 'right');
  });
});
