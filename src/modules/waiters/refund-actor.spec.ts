import { ForbiddenException } from '@nestjs/common';
import { ErrorReasons } from '../../common/constants/error-codes';
import type { Device } from '../../database/entities';
import { RefundsService } from '../refunds/refunds.service';
import {
  memberOperator,
  waiterOperator,
  type Operator,
} from './waiter-operator';
import { OrganizationRole } from '../../database/entities/user-organization.entity';

const anna = waiterOperator(
  {
    id: 'w-anna',
    name: 'Anna Berger',
    shortName: 'Anna',
    color: null,
    role: 'service',
    permissions: {},
  },
  's-anna',
);
const lead = waiterOperator(
  {
    id: 'w-lead',
    name: 'Lea Lead',
    shortName: 'Lea',
    color: null,
    role: 'lead',
    permissions: {},
  },
  null,
);
const ownerMember = memberOperator(
  { userId: 'u-admin', role: OrganizationRole.ADMIN, permissions: {} },
  { firstName: 'Ada', lastName: 'Admin' },
  null,
);

function setup(pins: Record<string, Operator> = {}) {
  const verifyApprover = jest.fn((_device: Device, pin: string) => {
    const who = pins[pin];
    if (!who) {
      return Promise.reject(
        new ForbiddenException({
          code: 'FORBIDDEN',
          reason: ErrorReasons.PIN_INVALID,
        }),
      );
    }
    return Promise.resolve(who);
  });
  const none = undefined as never;
  const service = new RefundsService(
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    none,
    undefined,
    { verifyApprover } as never,
  );
  const device = (policy?: string) =>
    ({
      id: 'dev-1',
      name: 'Kasse 1',
      organizationId: 'org-1',
      settings: policy ? { refundPermission: policy } : {},
    }) as unknown as Device;
  return { service, device, verifyApprover };
}

async function reasonOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return ((error as ForbiddenException).getResponse() as { reason: string })
      .reason;
  }
}

describe('Storno/Erstattung an der Kasse mit Bedienungen (resolveDeviceActor)', () => {
  it('ignores operatorUserId from the body (no attribution without session)', async () => {
    const { service, device } = setup();
    const actor = await service.resolveDeviceActor(device(), {
      operatorUserId: 'u-attacker',
    });
    expect(actor).toMatchObject({
      userId: null,
      waiterId: null,
      actorName: null,
    });
  });

  it('lets a server with the refund right refund directly', async () => {
    const { service, device, verifyApprover } = setup();
    const actor = await service.resolveDeviceActor(device('pin'), {}, lead);
    expect(actor).toMatchObject({ waiterId: 'w-lead', actorName: 'Lea Lead' });
    expect(verifyApprover).not.toHaveBeenCalled();
  });

  it('asks a server without the right for the PIN of a shift lead', async () => {
    const { service, device } = setup({ '3958': lead });
    expect(await reasonOf(service.resolveDeviceActor(device(), {}, anna))).toBe(
      ErrorReasons.REFUND_PIN_REQUIRED,
    );
    const actor = await service.resolveDeviceActor(
      device(),
      { pin: '3958' },
      anna,
    );
    expect(actor).toMatchObject({
      waiterId: 'w-anna',
      actorName: 'Anna Berger',
      approvedByWaiterId: 'w-lead',
      approvedByUserId: null,
    });
  });

  it('accepts the PIN of an admin member as approval', async () => {
    const { service, device } = setup({ '7146': ownerMember });
    const actor = await service.resolveDeviceActor(
      device(),
      { pin: '7146' },
      anna,
    );
    expect(actor).toMatchObject({
      waiterId: 'w-anna',
      approvedByUserId: 'u-admin',
    });
  });

  it('rejects the PIN of someone without the right', async () => {
    const other = waiterOperator(
      {
        id: 'w-ben',
        name: 'Ben',
        shortName: null,
        color: null,
        role: 'service',
        permissions: {},
      },
      null,
    );
    const { service, device } = setup({ '5021': other });
    expect(
      await reasonOf(
        service.resolveDeviceActor(device(), { pin: '5021' }, anna),
      ),
    ).toBe(ErrorReasons.REFUND_PIN_NOT_AUTHORIZED);
    expect(
      await reasonOf(
        service.resolveDeviceActor(device(), { pin: '0001' }, anna),
      ),
    ).toBe(ErrorReasons.PIN_INVALID);
  });

  it('keeps "disabled" closed for everybody', async () => {
    const { service, device } = setup();
    expect(
      await reasonOf(service.resolveDeviceActor(device('disabled'), {}, lead)),
    ).toBe(ErrorReasons.REFUND_NOT_ALLOWED);
  });

  it('without a session (mode off) "pin" still needs an authorized PIN, which becomes the actor', async () => {
    const { service, device } = setup({ '3958': lead });
    expect(await reasonOf(service.resolveDeviceActor(device('pin'), {}))).toBe(
      ErrorReasons.REFUND_PIN_REQUIRED,
    );
    const actor = await service.resolveDeviceActor(device('pin'), {
      pin: '3958',
    });
    expect(actor).toMatchObject({ waiterId: 'w-lead', actorName: 'Lea Lead' });
    const free = await service.resolveDeviceActor(device('allowed'), {});
    expect(free).toMatchObject({ waiterId: null, userId: null });
  });
});
