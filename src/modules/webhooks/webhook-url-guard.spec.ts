import {
  checkWebhookUrlSyntax,
  classifyAddress,
  isAddressAllowed,
  resolveWebhookTarget,
  validateWebhookUrl,
  WebhookTargetError,
  type LookupAll,
} from './webhook-url-guard';

const strict = { allowHttp: false, allowPrivateNetworks: false };

const lookupOf =
  (table: Record<string, string[]>): LookupAll =>
  (hostname) => {
    const addresses = table[hostname];
    if (!addresses) {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      return Promise.reject(error);
    }
    return Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  };

describe('classifyAddress (SSRF)', () => {
  it.each([
    ['93.184.216.34', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.178.1', 'private'],
    ['127.0.0.1', 'private'],
    ['127.255.0.9', 'private'],
    ['100.64.0.1', 'private'],
    ['::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'forbidden'],
    ['169.254.0.1', 'forbidden'],
    ['100.100.100.200', 'forbidden'],
    ['fd00:ec2::254', 'forbidden'],
    ['0.0.0.0', 'forbidden'],
    ['224.0.0.1', 'forbidden'],
    ['255.255.255.255', 'forbidden'],
    ['192.0.2.10', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['ff02::1', 'forbidden'],
    ['::', 'forbidden'],
    ['2001:db8::1', 'forbidden'],
    ['64:ff9b::7f00:1', 'forbidden'],
    ['2002:7f00:1::1', 'forbidden'],
    ['::ffff:127.0.0.1', 'private'],
    ['::ffff:7f00:1', 'private'],
    ['::ffff:169.254.169.254', 'forbidden'],
    ['::ffff:93.184.216.34', 'public'],
    ['not-an-ip', 'forbidden'],
  ])('%s → %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('private networks only with WEBHOOKS_ALLOW_PRIVATE_NETWORKS, metadata never', () => {
    expect(isAddressAllowed('10.0.0.1', { allowPrivateNetworks: false })).toBe(
      false,
    );
    expect(isAddressAllowed('10.0.0.1', { allowPrivateNetworks: true })).toBe(
      true,
    );
    expect(isAddressAllowed('127.0.0.1', { allowPrivateNetworks: true })).toBe(
      true,
    );
    expect(
      isAddressAllowed('169.254.169.254', { allowPrivateNetworks: true }),
    ).toBe(false);
    expect(isAddressAllowed('fe80::1', { allowPrivateNetworks: true })).toBe(
      false,
    );
  });
});

describe('checkWebhookUrlSyntax', () => {
  it.each([
    ['https://hooks.example.org/x?y=1', null],
    ['http://hooks.example.org/x', 'not_https'],
    ['ftp://hooks.example.org/x', 'invalid'],
    ['javascript:alert(1)', 'invalid'],
    ['https://user:pass@hooks.example.org/', 'credentials'],
    ['https://token@hooks.example.org/', 'credentials'],
    ['not a url', 'invalid'],
    ['', 'invalid'],
  ])('%s → %s', (url, problem) => {
    const result = checkWebhookUrlSyntax(url, strict);
    if (problem === null) expect('url' in result).toBe(true);
    else expect(result).toEqual({ problem });
  });

  it('allows http:// only with WEBHOOKS_ALLOW_HTTP', () => {
    expect(
      'url' in checkWebhookUrlSyntax('http://x.example/', { allowHttp: true }),
    ).toBe(true);
  });

  it('normalises numeric host tricks before the address check', () => {
    // WHATWG-URL macht aus 2130706433 / 0x7f.1 die Adresse 127.0.0.1.
    for (const raw of [
      'https://2130706433/',
      'https://0x7f.1/',
      'https://127.1/',
    ]) {
      const result = checkWebhookUrlSyntax(raw, strict);
      expect('url' in result && result.url.hostname).toBe('127.0.0.1');
    }
  });
});

describe('resolveWebhookTarget / validateWebhookUrl', () => {
  const lookup = lookupOf({
    'hooks.example.org': ['93.184.216.34'],
    'dual.example.org': ['93.184.216.34', '2606:4700::1'],
    'internal.example.org': ['10.0.0.5'],
    'mixed.example.org': ['93.184.216.34', '169.254.169.254'],
    localhost: ['127.0.0.1', '::1'],
  });

  it('returns the first address when all are public', async () => {
    await expect(
      resolveWebhookTarget('dual.example.org', strict, lookup),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('rejects a name if any address is not public', async () => {
    await expect(
      resolveWebhookTarget('mixed.example.org', strict, lookup),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(
      resolveWebhookTarget('internal.example.org', strict, lookup),
    ).rejects.toBeInstanceOf(WebhookTargetError);
    await expect(
      resolveWebhookTarget('localhost', strict, lookup),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
  });

  it('checks IP literals without DNS', async () => {
    const never: LookupAll = () => Promise.reject(new Error('no DNS expected'));
    await expect(
      resolveWebhookTarget('169.254.169.254', strict, never),
    ).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
    await expect(
      resolveWebhookTarget('93.184.216.34', strict, never),
    ).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('maps DNS errors to DNS_FAILED', async () => {
    await expect(
      resolveWebhookTarget('nope.example.org', strict, lookup),
    ).rejects.toMatchObject({
      code: 'DNS_FAILED',
    });
  });

  it('validateWebhookUrl reports the problem for the UI', async () => {
    await expect(
      validateWebhookUrl('https://hooks.example.org/a#frag', strict, lookup),
    ).resolves.toEqual({
      ok: true,
      url: 'https://hooks.example.org/a',
    });
    await expect(
      validateWebhookUrl('https://internal.example.org/', strict, lookup),
    ).resolves.toEqual({
      ok: false,
      problem: 'private_address',
    });
    await expect(
      validateWebhookUrl('https://[::1]/', strict, lookup),
    ).resolves.toEqual({
      ok: false,
      problem: 'private_address',
    });
    await expect(
      validateWebhookUrl('https://nope.example.org/', strict, lookup),
    ).resolves.toEqual({
      ok: false,
      problem: 'unresolvable',
    });
    await expect(
      validateWebhookUrl('http://hooks.example.org/', strict, lookup),
    ).resolves.toEqual({
      ok: false,
      problem: 'not_https',
    });
    await expect(
      validateWebhookUrl(
        'https://internal.example.org/',
        { ...strict, allowPrivateNetworks: true },
        lookup,
      ),
    ).resolves.toEqual({ ok: true, url: 'https://internal.example.org/' });
  });
});
