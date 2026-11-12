import { BadRequestException } from '@nestjs/common';

import { ErrorReasons } from '../../common/constants/error-codes';
import { WaiterSettlementsService } from './waiter-settlements.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const WAITER = '22222222-2222-4222-8222-222222222222';
const OTHER_EVENT = '33333333-3333-4333-8333-333333333333';

describe('waiter settlement references', () => {
  it('rejects an event of another organization before settling', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const transaction = jest.fn();
    const service = new WaiterSettlementsService({
      query,
      transaction,
    } as never);

    const attempt = service.settle(
      ORG,
      { kind: 'waiter', waiterId: WAITER },
      {
        userId: 'user-1',
        waiterId: null,
        mayForce: true,
        deviceId: null,
      } as never,
      { eventId: OTHER_EVENT },
    );

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({
      response: { reason: ErrorReasons.EVENT_NOT_FOUND },
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      [OTHER_EVENT],
      ORG,
    ]);
    expect(transaction).not.toHaveBeenCalled();
  });
});
