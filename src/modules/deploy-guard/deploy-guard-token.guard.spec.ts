import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DeployGuardTokenGuard } from './deploy-guard-token.guard';

const TOKEN = 'a'.repeat(48);

function context(authorization?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as never;
}

function guard(token: string | undefined) {
  return new DeployGuardTokenGuard({ get: () => token } as never);
}

describe('DeployGuardTokenGuard', () => {
  it('hides the endpoint when no token is configured', () => {
    expect(() =>
      guard(undefined).canActivate(context(`Bearer ${TOKEN}`)),
    ).toThrow(NotFoundException);
    expect(() => guard('').canActivate(context(`Bearer ${TOKEN}`))).toThrow(
      NotFoundException,
    );
  });

  it('lets the right token through', () => {
    expect(guard(TOKEN).canActivate(context(`Bearer ${TOKEN}`))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['wrong token', `Bearer ${'b'.repeat(48)}`],
    ['token prefix only', `Bearer ${TOKEN.slice(0, 10)}`],
    ['other scheme', `Basic ${TOKEN}`],
    ['empty bearer', 'Bearer '],
  ])('rejects %s', (_label, header) => {
    expect(() => guard(TOKEN).canActivate(context(header))).toThrow(
      UnauthorizedException,
    );
  });
});
