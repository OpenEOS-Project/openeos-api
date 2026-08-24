import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  CanActivate,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RentalAssignment } from '../../database/entities';
import { RentalAssignmentStatus } from '../../database/entities/rental-assignment.entity';
import { ErrorCodes } from '../constants/error-codes';

/**
 * Authenticates a box's SyncPushService against POST /sync/push
 * (docs/design/offline-box-sync.md §5). Mirrors DeviceAuthGuard's shape,
 * but the credential here is RentalAssignment.syncToken (issued at
 * provisioning), not a Device token — a box authenticates as "this rental
 * assignment", not as any one device inside it.
 */
@Injectable()
export class SyncTokenGuard implements CanActivate {
  constructor(
    @InjectRepository(RentalAssignment)
    private readonly rentalAssignmentRepository: Repository<RentalAssignment>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    if (!token) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Sync-Token fehlt',
      });
    }

    const assignment = await this.rentalAssignmentRepository.findOne({
      where: { syncToken: token, status: RentalAssignmentStatus.ACTIVE },
    });

    if (!assignment) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Ungültiger Sync-Token',
      });
    }

    request.rentalAssignment = assignment;
    return true;
  }
}
