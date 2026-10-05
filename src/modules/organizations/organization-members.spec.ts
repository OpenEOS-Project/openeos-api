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
import { ErrorCodes } from '../../common/constants/error-codes';
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
    count: jest.fn(() => Promise.resolve(2)),
  } as unknown as Repository<UserOrganization>;

  const deployment = {
    isSelfHosted: options.selfHosted ?? true,
  } as DeploymentService;

  const none = undefined as never;
  const service = new OrganizationsService(
    none,
    userRepository,
    userOrganizationRepository,
    none,
    none,
    none,
    none,
    none,
    deployment,
  );

  return { service, createdUsers, savedMemberships };
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
