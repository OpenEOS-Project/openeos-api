import { Controller, Post, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TseService } from './tse.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';

@ApiTags('TSE')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/tse')
export class TseController {
  constructor(private readonly tseService: TseService) {}

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  testConnection(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.tseService.testConnection(organizationId, user.id);
  }
}
