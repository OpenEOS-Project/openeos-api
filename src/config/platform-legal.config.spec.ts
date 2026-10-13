/*
 * Plattform-Links (Impressum/Datenschutz von OpenEOS) je Betriebsart.
 * configuration.ts liest DEPLOYMENT_MODE beim Laden des Moduls, deshalb
 * wird es je Fall frisch geladen.
 */
function loadPlatform(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const key of [
    'DEPLOYMENT_MODE',
    'PLATFORM_IMPRINT_URL',
    'PLATFORM_PRIVACY_URL',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let platform: { imprintUrl: string; privacyUrl: string } | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./configuration') as {
        default: () => {
          platform: { imprintUrl: string; privacyUrl: string };
        };
      };
      platform = mod.default().platform;
    });
    return platform!;
  } finally {
    process.env = saved;
  }
}

describe('platform legal links', () => {
  it('defaults to openeos.de in the hosted service', () => {
    expect(loadPlatform({})).toEqual({
      imprintUrl: 'https://openeos.de/imprint',
      privacyUrl: 'https://openeos.de/privacy',
    });
  });

  it('shows no platform links when self-hosted without configuration', () => {
    expect(loadPlatform({ DEPLOYMENT_MODE: 'selfhosted' })).toEqual({
      imprintUrl: '',
      privacyUrl: '',
    });
  });

  it('uses configured links, and an empty value hides the link', () => {
    expect(
      loadPlatform({
        DEPLOYMENT_MODE: 'selfhosted',
        PLATFORM_IMPRINT_URL: 'https://verein.example/impressum',
        PLATFORM_PRIVACY_URL: 'https://verein.example/datenschutz',
      }),
    ).toEqual({
      imprintUrl: 'https://verein.example/impressum',
      privacyUrl: 'https://verein.example/datenschutz',
    });
    expect(loadPlatform({ PLATFORM_IMPRINT_URL: '' }).imprintUrl).toBe('');
  });
});
