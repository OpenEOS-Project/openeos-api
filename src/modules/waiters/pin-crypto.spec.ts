import {
  generatePin,
  hashSessionToken,
  isTrivialPin,
  newSessionToken,
  pepperFingerprint,
  pinLookup,
  resolvePepper,
} from './pin-crypto';

describe('PIN crypto (bedienungen-plan.md §11)', () => {
  const pepper = Buffer.from('test-pepper-0123456789abcdef', 'utf8');
  const org = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';

  it('derives a stable HMAC per organization and pepper, never the PIN itself', () => {
    const a = pinLookup(pepper, org, '3958');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('3958');
    expect(pinLookup(pepper, org, '3958')).toBe(a);
    expect(pinLookup(pepper, org.toUpperCase(), '3958')).toBe(a);
    expect(pinLookup(pepper, 'b'.repeat(36), '3958')).not.toBe(a);
    expect(pinLookup(Buffer.from('other'), org, '3958')).not.toBe(a);
    expect(pinLookup(pepper, org, '3959')).not.toBe(a);
  });

  it('uses PIN_PEPPER, else derives from TWO_FACTOR_ENCRYPTION_KEY, else a dev value', () => {
    expect(resolvePepper({ pinPepper: ' own-pepper ' }).origin).toBe('env');
    expect(resolvePepper({ pinPepper: 'own-pepper' }).pepper.toString()).toBe(
      'own-pepper',
    );
    const derived = resolvePepper({ pinPepper: '', fallbackSecret: 'key' });
    expect(derived.origin).toBe('derived');
    expect(derived.pepper.toString('hex')).not.toContain(
      Buffer.from('key').toString('hex'),
    );
    expect(
      resolvePepper({ fallbackSecret: 'key' }).pepper.equals(derived.pepper),
    ).toBe(true);
    expect(resolvePepper({}).origin).toBe('development');
  });

  it('fingerprints the pepper without revealing it', () => {
    const id = pepperFingerprint(pepper);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(pepperFingerprint(pepper)).toBe(id);
    expect(pepperFingerprint(Buffer.from('x'))).not.toBe(id);
  });

  it.each([
    '0000',
    '1111',
    '1234',
    '4321',
    '7890',
    '0987',
    '1212',
    '123123',
    '121212',
    '999999',
    '123456',
    '654321',
    '2580',
    '1122',
    '12a4',
    '123',
    '1234567',
  ])('treats %s as too simple or invalid', (pin) => {
    expect(isTrivialPin(pin)).toBe(true);
  });

  it.each(['3958', '7146', '502817', '8301'])('accepts %s', (pin) => {
    expect(isTrivialPin(pin)).toBe(false);
  });

  it('generates PINs of the requested length that are never trivial', () => {
    for (let i = 0; i < 500; i += 1) {
      const four = generatePin(4);
      const six = generatePin(6);
      expect(four).toMatch(/^\d{4}$/);
      expect(six).toMatch(/^\d{6}$/);
      expect(isTrivialPin(four)).toBe(false);
      expect(isTrivialPin(six)).toBe(false);
    }
  });

  it('creates random session tokens and stores only their SHA-256', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});
