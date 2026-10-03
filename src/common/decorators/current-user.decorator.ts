import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../database/entities';
import type { AppRequest } from '../types/request.types';

export interface JwtPayload {
  sub: string;
  email: string;
  type: 'access' | 'refresh';
  organizations: { id: string; role: string }[];
  iat: number;
  exp: number;
}

export interface RequestUser extends Partial<User> {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  organizations: { id: string; role: string }[];
  /** Sitzung aus dem Zugangstoken (`sid`); null bei Token ohne Sitzung. */
  sessionId?: string | null;
}

export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    const user = request.user as RequestUser;

    if (data) {
      return user?.[data];
    }

    return user;
  },
);
