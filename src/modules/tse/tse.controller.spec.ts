import { TseController } from './tse.controller';
import { TseService } from './tse.service';

describe('TseController', () => {
  let tseService: jest.Mocked<Pick<TseService, 'testConnection'>>;
  let controller: TseController;

  const user = { id: 'user-1' } as any;
  const ORG_ID = 'org-1';

  beforeEach(() => {
    tseService = {
      testConnection: jest.fn(),
    };
    controller = new TseController(tseService as unknown as TseService);
  });

  it('testConnection delegates to the service with the caller identity', () => {
    controller.testConnection(ORG_ID, user);
    expect(tseService.testConnection).toHaveBeenCalledWith(ORG_ID, 'user-1');
  });
});
