import { ConfigService } from '@nestjs/config';

import type { DeploymentService } from '../../common/services/deployment.service';
import { LegalController } from './legal.controller';
import type { LegalService } from './legal.service';
import { tseConditionsFrom } from './tse-conditions';

const SWISSBIT = {
  TSE_PROVIDER: 'swissbit',
  SWISSBIT_CREDIT_CLIENT_ID: 'id',
  SWISSBIT_CREDIT_CLIENT_SECRET: 'secret',
  SWISSBIT_PRODUCT_TYPE: '850004',
};

describe('GET /legal/versions', () => {
  it('includes the platform links and no TSE conditions without Cloud-TSE', () => {
    const versions = {
      enabled: true,
      siteUrl: 'https://staging.openeos.de',
      documents: {},
    };
    const platformLegal = {
      imprintUrl: 'https://staging.openeos.de/impressum',
      privacyUrl: 'https://staging.openeos.de/datenschutz',
    };
    const controller = new LegalController(
      { versions: () => versions } as unknown as LegalService,
      { platformLegal } as DeploymentService,
      new ConfigService({}),
    );

    expect(controller.getVersions()).toEqual({
      data: { ...versions, platform: platformLegal, tseConditions: null },
    });
  });
});

describe('TSE conditions (Umgebungsschutzkonzept)', () => {
  it('are hidden while the Cloud-TSE is only announced', () => {
    expect(
      tseConditionsFrom(
        new ConfigService({
          TSE_COMING_SOON: 'true',
          TSE_CONDITIONS_URL: 'https://example.org/x.pdf',
        }),
      ),
    ).toBeNull();
  });

  it('show a placeholder when the Cloud-TSE is available but nothing is configured', () => {
    expect(tseConditionsFrom(new ConfigService(SWISSBIT))).toEqual({
      url: null,
      text: null,
    });
  });

  it('use the configured link and text, never non-http links', () => {
    expect(
      tseConditionsFrom(
        new ConfigService({
          ...SWISSBIT,
          TSE_CONDITIONS_URL: 'https://swissbit.example/umgebungsschutz.pdf',
          TSE_CONDITIONS_TEXT: 'Absatz eins.\\nAbsatz zwei.',
        }),
      ),
    ).toEqual({
      url: 'https://swissbit.example/umgebungsschutz.pdf',
      text: 'Absatz eins.\nAbsatz zwei.',
    });
    expect(
      tseConditionsFrom(
        new ConfigService({
          ...SWISSBIT,
          TSE_CONDITIONS_URL: 'javascript:alert(1)',
        }),
      )?.url,
    ).toBeNull();
  });
});
