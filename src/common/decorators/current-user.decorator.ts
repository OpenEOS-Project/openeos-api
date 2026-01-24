import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../database/entities';

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
  isSuperadmin: boolean;
  organizations: { id: string; role: string }[];
}

export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext): RequestUser | unknown => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as RequestUser;

    if (data) {
      return user?.[data];
    }

    return user;
  },
);
