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
    'PLATFORM_CONTACT_EMAIL',
    'PLATFORM_REPORT_URL',
    'APP_URL',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let platform: Record<string, string> | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./configuration') as {
        default: () => {
          platform: Record<string, string>;
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
      imprintUrl: 'https://openeos.de/impressum',
      privacyUrl: 'https://openeos.de/datenschutz',
      contactEmail: 'hello@openeos.de',
      reportUrl: 'https://app.openeos.de/report',
    });
  });

  it('shows no platform links when self-hosted without configuration', () => {
    expect(loadPlatform({ DEPLOYMENT_MODE: 'selfhosted' })).toEqual({
      imprintUrl: '',
      privacyUrl: '',
      contactEmail: '',
      reportUrl: '',
    });
  });

  it('uses configured links, and an empty value hides the link', () => {
    expect(
      loadPlatform({
        DEPLOYMENT_MODE: 'selfhosted',
        PLATFORM_IMPRINT_URL: 'https://verein.example/impressum',
        PLATFORM_PRIVACY_URL: 'https://verein.example/datenschutz',
      }),
    ).toMatchObject({
      imprintUrl: 'https://verein.example/impressum',
      privacyUrl: 'https://verein.example/datenschutz',
      contactEmail: '',
      reportUrl: '',
    });
    expect(loadPlatform({ PLATFORM_IMPRINT_URL: '' }).imprintUrl).toBe('');
  });

  it('links the report form of the app and the DSA contact point', () => {
    expect(
      loadPlatform({ APP_URL: 'https://app.staging.openeos.de/' }).reportUrl,
    ).toBe('https://app.staging.openeos.de/report');
    expect(
      loadPlatform({
        DEPLOYMENT_MODE: 'selfhosted',
        APP_URL: 'https://kasse.verein.example',
        PLATFORM_CONTACT_EMAIL: 'it@verein.example',
      }),
    ).toMatchObject({
      reportUrl: 'https://kasse.verein.example/report',
      contactEmail: 'it@verein.example',
    });
  });
});
