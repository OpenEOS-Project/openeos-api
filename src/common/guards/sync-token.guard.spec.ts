import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncTokenGuard } from './sync-token.guard';
import {
  RentalAssignment,
  RentalAssignmentStatus,
} from '../../database/entities/rental-assignment.entity';

describe('SyncTokenGuard', () => {
  let guard: SyncTokenGuard;
  let findOne: jest.Mock;

  interface FakeRequest {
    headers: Record<string, string>;
    rentalAssignment?: RentalAssignment;
  }

  function contextWithHeaders(headers: Record<string, string>): {
    context: ExecutionContext;
    request: FakeRequest;
  } {
    const request: FakeRequest = { headers };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(async () => {
    findOne = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncTokenGuard,
        {
          provide: getRepositoryToken(RentalAssignment),
          useValue: { findOne },
        },
      ],
    }).compile();

    guard = module.get(SyncTokenGuard);
  });

  it('rejects a request with no Authorization header', async () => {
    const { context } = contextWithHeaders({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', async () => {
    const { context } = contextWithHeaders({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects a token with no matching active rental assignment', async () => {
    findOne.mockResolvedValue(null);
    const { context } = contextWithHeaders({ authorization: 'Bearer nope' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findOne).toHaveBeenCalledWith({
      where: { syncToken: 'nope', status: RentalAssignmentStatus.ACTIVE },
    });
  });

  it('accepts a valid token and attaches the assignment to the request', async () => {
    const assignment = { id: 'assignment-1' } as RentalAssignment;
    findOne.mockResolvedValue(assignment);
    const { context, request } = contextWithHeaders({
      authorization: 'Bearer good-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.rentalAssignment).toBe(assignment);
  });
});
