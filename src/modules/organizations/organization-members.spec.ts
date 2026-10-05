import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';

import { User } from '../../database/entities/user.entity';
import {
  OrganizationPermissions,
  OrganizationRole,
  UserOrganization,
} from '../../database/entities/user-organization.entity';
import { DeploymentService } from '../../common/services/deployment.service';
import { Invitation } from '../../database/entities/invitation.entity';
import { ErrorCodes, ErrorReasons } from '../../common/constants/error-codes';
import { DevicesService } from '../devices/devices.service';
import { AddMemberDto } from './dto';
import { OrganizationsService } from './organizations.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

const ORG_ID = '7d0c7a52-4f43-4a3e-9f8e-0f2b8f3f1a11';
const ACTOR = { id: 'actor', isSuperAdmin: false } as User;

interface Options {
  actorRole: OrganizationRole;
  actorPermissions?: OrganizationPermissions;
  existingUser?: User | null;
  selfHosted?: boolean;
  target?: Partial<UserOrganization>;
  invitation?: Partial<Invitation>;
  adminCount?: number;
}

function setup(options: Options) {
  const createdUsers: User[] = [];
  const userRepository = {
    findOne: jest.fn(() => Promise.resolve(options.existingUser ?? null)),
    create: jest.fn((data: Partial<User>) => ({ id: 'new-user', ...data })),
    save: jest.fn((user: User) => {
      createdUsers.push(user);
      return Promise.resolve(user);
    }),
  } as unknown as Repository<User>;

  const actorMembership = {
    role: options.actorRole,
    permissions: options.actorPermissions ?? {},
  } as UserOrganization;

  const savedMemberships: Partial<UserOrganization>[] = [];
  const removed: unknown[] = [];
  const userOrganizationRepository = {
    findOne: jest.fn(
      ({ where }: { where: { userId?: string; id?: string } }) => {
        if (where.userId === ACTOR.id) return Promise.resolve(actorMembership);
        if (where.id && options.target) {
          return Promise.resolve({
            user: { email: 'target@example.com' },
            ...options.target,
          });
        }
        return Promise.resolve(null);
      },
    ),
    create: jest.fn((data: Partial<UserOrganization>) => ({
      id: 'membership',
      ...data,
    })),
    save: jest.fn((membership: Partial<UserOrganization>) => {
      savedMemberships.push(membership);
      return Promise.resolve(membership);
    }),
    findOneOrFail: jest.fn(() => Promise.resolve(savedMemberships.at(-1))),
    count: jest.fn(() => Promise.resolve(options.adminCount ?? 2)),
    remove: jest.fn((membership: unknown) => {
      removed.push(membership);
      return Promise.resolve(membership);
    }),
  } as unknown as Repository<UserOrganization>;

  const invitationRepository = {
    findOne: jest.fn(() =>
      Promise.resolve(
        options.invitation
          ? {
              organization: { name: 'Verein' },
              isExpired: () => false,
              isAccepted: () => false,
              ...options.invitation,
            }
          : null,
      ),
    ),
    remove: jest.fn((invitation: unknown) => {
      removed.push(invitation);
      return Promise.resolve(invitation);
    }),
  } as unknown as Repository<Invitation>;
  const sentMails: unknown[] = [];
  const emailService = {
    sendInvitationEmail: jest.fn((...args: unknown[]) => {
      sentMails.push(args);
      return Promise.resolve();
    }),
  };
  const configService = { get: jest.fn(() => undefined) };

  const deployment = {
    isSelfHosted: options.selfHosted ?? true,
  } as DeploymentService;

  const none = undefined as never;
  const service = new OrganizationsService(
    none,
    userRepository,
    userOrganizationRepository,
    invitationRepository,
    none,
    emailService as never,
    none,
    configService as never,
    deployment,
  );

  return { service, createdUsers, savedMemberships, removed, sentMails };
}

const newAccount: AddMemberDto = {
  email: 'Neu@Example.com',
  role: OrganizationRole.MEMBER,
  permissions: { products: true },
  firstName: 'Erika',
  lastName: 'Muster',
  password: 'Startpasswort1',
};

async function expectCode(
  promise: Promise<unknown>,
  type: unknown,
  code: string,
) {
  await expect(promise).rejects.toBeInstanceOf(type);
  await promise.catch((error: { getResponse: () => { code: string } }) => {
    expect(error.getResponse().code).toBe(code);
  });
}

async function expectReason(promise: Promise<unknown>, reason: string) {
  await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
  await promise.catch((error: { getResponse: () => { reason: string } }) => {
    expect(error.getResponse().reason).toBe(reason);
  });
}

const MANAGER = {
  actorRole: OrganizationRole.MEMBER,
  actorPermissions: { members: true, products: true },
};

describe('AddMemberDto', () => {
  const check = async (password: string) => {
    const dto = plainToInstance(AddMemberDto, { ...newAccount, password });
    const errors = await validate(dto);
    return errors.filter((e) => e.property === 'password');
  };

  it('accepts a password that satisfies the registration rules', async () => {
    expect(await check('Startpasswort1')).toHaveLength(0);
  });

  it.each([
    ['too short', 'Ab1'],
    ['no uppercase letter', 'startpasswort1'],
    ['no lowercase letter', 'STARTPASSWORT1'],
    ['no digit', 'Startpasswort'],
    ['longer than 72 characters', 'Aa1' + 'x'.repeat(70)],
  ])('rejects a password that is %s', async (_label, password) => {
    expect(await check(password)).not.toHaveLength(0);
  });
});

describe('OrganizationsService.addMember', () => {
  it('creates a verified account in self-hosted mode for admins', async () => {
    const { service, createdUsers, savedMemberships } = setup({
      actorRole: OrganizationRole.ADMIN,
    });

    await service.addMember(ORG_ID, newAccount, ACTOR);

    expect(createdUsers).toHaveLength(1);
    const [user] = createdUsers;
    expect(user.email).toBe('neu@example.com');
    expect(user.isSuperAdmin).toBe(false);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).not.toBe(newAccount.password);
    expect(savedMemberships[0]).toMatchObject({
      role: OrganizationRole.MEMBER,
      permissions: { products: true },
    });
  });

  it('rejects a start password for an existing account', async () => {
    const { service, createdUsers } = setup({
      actorRole: OrganizationRole.ADMIN,
      existingUser: { id: 'existing' } as User,
    });

    await expectCode(
      service.addMember(ORG_ID, newAccount, ACTOR),
      ConflictException,
      ErrorCodes.USER_EXISTS,
    );
    expect(createdUsers).toHaveLength(0);
  });

  it('requires name fields when creating an account', async () => {
    const { service } = setup({ actorRole: OrganizationRole.ADMIN });

    await expect(
      service.addMember(ORG_ID, { ...newAccount, firstName: undefined }, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not create accounts in hosted mode', async () => {
    const { service, createdUsers } = setup({
      actorRole: OrganizationRole.ADMIN,
      selfHosted: false,
    });

    await expect(
      service.addMember(ORG_ID, newAccount, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(createdUsers).toHaveLength(0);
  });

  it('only lets admins create accounts with a start password', async () => {
    const { service, createdUsers } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true, products: true },
    });

    await expectCode(
      service.addMember(ORG_ID, newAccount, ACTOR),
      ForbiddenException,
      ErrorCodes.FORBIDDEN,
    );
    expect(createdUsers).toHaveLength(0);
  });

  it('does not let non-admins assign the admin role', async () => {
    const { service } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true },
      existingUser: { id: 'existing' } as User,
    });

    await expect(
      service.addMember(
        ORG_ID,
        { email: 'x@example.com', role: OrganizationRole.ADMIN },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let non-admins grant permissions they lack', async () => {
    const { service, savedMemberships } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true },
      existingUser: { id: 'existing' } as User,
    });

    await expect(
      service.addMember(
        ORG_ID,
        {
          email: 'x@example.com',
          role: OrganizationRole.MEMBER,
          permissions: { reports: true },
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await service.addMember(
      ORG_ID,
      {
        email: 'x@example.com',
        role: OrganizationRole.MEMBER,
        permissions: { members: true, reports: false },
      },
      ACTOR,
    );
    expect(savedMemberships).toHaveLength(1);
  });
});

describe('OrganizationsService.updateMember', () => {
  it('does not let non-admins promote members to admin', async () => {
    const { service } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true },
      target: { id: 'm1', role: OrganizationRole.MEMBER, permissions: {} },
    });

    await expect(
      service.updateMember(
        ORG_ID,
        'm1',
        { role: OrganizationRole.ADMIN },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let non-admins change admins', async () => {
    const { service } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true },
      target: { id: 'm1', role: OrganizationRole.ADMIN, permissions: {} },
    });

    await expect(
      service.updateMember(
        ORG_ID,
        'm1',
        { role: OrganizationRole.MEMBER },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps permissions the member already holds', async () => {
    const { service, savedMemberships } = setup({
      actorRole: OrganizationRole.MEMBER,
      actorPermissions: { members: true },
      target: {
        id: 'm1',
        role: OrganizationRole.MEMBER,
        permissions: { reports: true },
      },
    });

    await service.updateMember(
      ORG_ID,
      'm1',
      { permissions: { reports: true, members: true } },
      ACTOR,
    );
    expect(savedMemberships[0].permissions).toEqual({
      reports: true,
      members: true,
    });
  });
});

describe('OrganizationsService.updateMember (role and permission changes)', () => {
  it('does not let non-admins revoke permissions they lack', async () => {
    const { service, savedMemberships } = setup({
      ...MANAGER,
      target: {
        id: 'm1',
        role: OrganizationRole.MEMBER,
        permissions: { reports: true, products: true },
      },
    });

    await expectReason(
      service.updateMember(ORG_ID, 'm1', { permissions: {} }, ACTOR),
      ErrorReasons.PERMISSIONS_EXCEED_OWN,
    );

    await service.updateMember(
      ORG_ID,
      'm1',
      { permissions: { reports: true } },
      ACTOR,
    );
    expect(savedMemberships[0].permissions).toEqual({ reports: true });
  });

  it('treats truthy non-boolean values as granted', async () => {
    const { service } = setup({
      ...MANAGER,
      target: { id: 'm1', role: OrganizationRole.MEMBER, permissions: {} },
    });

    await expectReason(
      service.updateMember(
        ORG_ID,
        'm1',
        { permissions: { reports: 1 } as unknown as OrganizationPermissions },
        ACTOR,
      ),
      ErrorReasons.PERMISSIONS_EXCEED_OWN,
    );
  });

  it('keeps the last admin even when someone else demotes them', async () => {
    const { service, savedMemberships } = setup({
      actorRole: OrganizationRole.ADMIN,
      adminCount: 1,
      target: {
        id: 'm1',
        userId: 'someone-else',
        role: OrganizationRole.ADMIN,
        permissions: {},
      },
    });

    await expectCode(
      service.updateMember(
        ORG_ID,
        'm1',
        { role: OrganizationRole.MEMBER },
        ACTOR,
      ),
      BadRequestException,
      ErrorCodes.FORBIDDEN,
    );
    expect(savedMemberships).toHaveLength(0);
  });

  it('lets an admin step down while another admin remains', async () => {
    const { service, savedMemberships } = setup({
      actorRole: OrganizationRole.ADMIN,
      adminCount: 2,
      target: {
        id: 'm1',
        userId: ACTOR.id,
        role: OrganizationRole.ADMIN,
        permissions: {},
      },
    });

    await service.updateMember(
      ORG_ID,
      'm1',
      { role: OrganizationRole.MEMBER },
      ACTOR,
    );
    expect(savedMemberships[0].role).toBe(OrganizationRole.MEMBER);
  });
});

describe('OrganizationsService.removeMember', () => {
  it('does not let non-admins remove admins', async () => {
    const { service, removed } = setup({
      ...MANAGER,
      target: { id: 'm1', role: OrganizationRole.ADMIN, permissions: {} },
    });

    await expectReason(
      service.removeMember(ORG_ID, 'm1', ACTOR),
      ErrorReasons.ADMIN_REQUIRED_TO_EDIT_ADMIN,
    );
    expect(removed).toHaveLength(0);
  });

  it('does not let non-admins remove members with more permissions', async () => {
    const { service, removed } = setup({
      ...MANAGER,
      target: {
        id: 'm1',
        role: OrganizationRole.MEMBER,
        permissions: { products: true, reports: true },
      },
    });

    await expectReason(
      service.removeMember(ORG_ID, 'm1', ACTOR),
      ErrorReasons.PERMISSIONS_EXCEED_OWN,
    );
    expect(removed).toHaveLength(0);
  });

  it('lets non-admins remove members within their own permissions', async () => {
    const { service, removed } = setup({
      ...MANAGER,
      target: {
        id: 'm1',
        role: OrganizationRole.MEMBER,
        permissions: { products: true, reports: false },
      },
    });

    await service.removeMember(ORG_ID, 'm1', ACTOR);
    expect(removed).toHaveLength(1);
  });

  it('lets admins remove admins but never the last one', async () => {
    const target = { id: 'm1', role: OrganizationRole.ADMIN, permissions: {} };

    const twoAdmins = setup({ actorRole: OrganizationRole.ADMIN, target });
    await twoAdmins.service.removeMember(ORG_ID, 'm1', ACTOR);
    expect(twoAdmins.removed).toHaveLength(1);

    const lastAdmin = setup({
      actorRole: OrganizationRole.ADMIN,
      adminCount: 1,
      target,
    });
    await expectCode(
      lastAdmin.service.removeMember(ORG_ID, 'm1', ACTOR),
      BadRequestException,
      ErrorCodes.FORBIDDEN,
    );
    expect(lastAdmin.removed).toHaveLength(0);
  });
});

describe('OrganizationsService invitations', () => {
  it.each([
    [
      'an admin invitation',
      { role: OrganizationRole.ADMIN, permissions: {} },
      ErrorReasons.ADMIN_REQUIRED_TO_EDIT_ADMIN,
    ],
    [
      'an invitation with more permissions',
      { role: OrganizationRole.MEMBER, permissions: { reports: true } },
      ErrorReasons.PERMISSIONS_EXCEED_OWN,
    ],
  ])(
    'does not let non-admins cancel or resend %s',
    async (_label, invitation, reason) => {
      const { service, removed, sentMails } = setup({
        ...MANAGER,
        invitation: { id: 'i1', ...invitation },
      });

      await expectReason(service.cancelInvitation(ORG_ID, 'i1', ACTOR), reason);
      await expectReason(service.resendInvitation(ORG_ID, 'i1', ACTOR), reason);
      expect(removed).toHaveLength(0);
      expect(sentMails).toHaveLength(0);
    },
  );

  it('lets non-admins cancel and resend invitations within their permissions', async () => {
    const { service, removed, sentMails } = setup({
      ...MANAGER,
      invitation: {
        id: 'i1',
        email: 'x@example.com',
        role: OrganizationRole.MEMBER,
        permissions: { products: true },
      },
    });

    await service.resendInvitation(ORG_ID, 'i1', ACTOR);
    await service.cancelInvitation(ORG_ID, 'i1', ACTOR);
    expect(sentMails).toHaveLength(1);
    expect(removed).toHaveLength(1);
  });
});

describe('DevicesService member PINs', () => {
  function setupPins(target: Partial<UserOrganization>) {
    const actorMembership = {
      userId: ACTOR.id,
      role: MANAGER.actorRole,
      permissions: MANAGER.actorPermissions,
    } as UserOrganization;
    const saved: Partial<UserOrganization>[] = [];
    const repository = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          where.userId === ACTOR.id
            ? actorMembership
            : where.userId === target.userId
              ? { ...target }
              : null,
        ),
      ),
      find: jest.fn(() => Promise.resolve([])),
      save: jest.fn((membership: Partial<UserOrganization>) => {
        saved.push(membership);
        return Promise.resolve(membership);
      }),
    } as unknown as Repository<UserOrganization>;

    const none = undefined as never;
    const service = new DevicesService(
      none,
      repository,
      none,
      none,
      none,
      none,
    );
    return { service, saved };
  }

  it.each([
    [
      'an admin',
      { role: OrganizationRole.ADMIN, permissions: {} },
      ErrorReasons.ADMIN_REQUIRED_TO_EDIT_ADMIN,
    ],
    [
      'a member with more permissions',
      { role: OrganizationRole.MEMBER, permissions: { reports: true } },
      ErrorReasons.PERMISSIONS_EXCEED_OWN,
    ],
  ])(
    'does not let non-admins set or remove the PIN of %s',
    async (_label, target, reason) => {
      const { service, saved } = setupPins({ userId: 'u1', ...target });

      await expectReason(
        service.setMemberPin(ORG_ID, 'u1', '1234', ACTOR),
        reason,
      );
      await expectReason(service.removeMemberPin(ORG_ID, 'u1', ACTOR), reason);
      expect(saved).toHaveLength(0);
    },
  );

  it('lets non-admins manage PINs within their permissions', async () => {
    const { service, saved } = setupPins({
      userId: 'u1',
      role: OrganizationRole.MEMBER,
      permissions: { products: true },
    });

    await service.setMemberPin(ORG_ID, 'u1', '1234', ACTOR);
    await service.removeMemberPin(ORG_ID, 'u1', ACTOR);
    expect(saved).toHaveLength(2);
    expect(saved[1].pin).toBeNull();
  });
});
