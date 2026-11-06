import type { DeploymentService } from '../../common/services/deployment.service';
import { LegalController } from './legal.controller';
import type { LegalService } from './legal.service';

describe('GET /legal/versions', () => {
  it('includes the platform imprint and privacy links', () => {
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
    );

    expect(controller.getVersions()).toEqual({
      data: { ...versions, platform: platformLegal },
    });
  });
});
