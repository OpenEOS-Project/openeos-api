import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RentalAssignment } from '../../database/entities';

export const CurrentRentalAssignment = createParamDecorator(
  (
    data: keyof RentalAssignment | undefined,
    ctx: ExecutionContext,
  ): RentalAssignment | unknown => {
    const request = ctx.switchToHttp().getRequest();
    const assignment = request.rentalAssignment as RentalAssignment;

    if (data) {
      return assignment?.[data];
    }

    return assignment;
  },
);
