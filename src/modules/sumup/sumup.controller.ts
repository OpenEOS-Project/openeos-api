import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SumUpService } from './sumup.service';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { PairReaderDto, UpdateReaderDto, InitiateCheckoutDto } from './dto';

@ApiTags('SumUp')
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId/sumup')
export class SumUpController {
  constructor(private readonly sumUpService: SumUpService) {}

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  testConnection(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.testConnection(organizationId, user);
  }

  @Get('readers')
  listReaders(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.listReaders(organizationId, user);
  }

  @Post('readers')
  pairReader(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() pairReaderDto: PairReaderDto,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.pairReader(organizationId, pairReaderDto.pairingCode, pairReaderDto.name, user);
  }

  @Get('readers/:readerId/status')
  getReaderStatus(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('readerId') readerId: string,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.getReaderStatus(organizationId, readerId, user);
  }

  @Patch('readers/:readerId')
  updateReader(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('readerId') readerId: string,
    @Body() updateReaderDto: UpdateReaderDto,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.updateReader(organizationId, readerId, updateReaderDto.name, user);
  }

  @Delete('readers/:readerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteReader(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('readerId') readerId: string,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.deleteReader(organizationId, readerId, user);
  }

  @Post('readers/:readerId/checkout')
  initiateCheckout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('readerId') readerId: string,
    @Body() checkoutDto: InitiateCheckoutDto,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.initiateCheckout(
      organizationId,
      readerId,
      checkoutDto.amount,
      checkoutDto.currency,
      user,
    );
  }

  @Post('readers/:readerId/terminate')
  @HttpCode(HttpStatus.OK)
  terminateCheckout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('readerId') readerId: string,
    @CurrentUser() user: User,
  ) {
    return this.sumUpService.terminateCheckout(organizationId, readerId, user);
  }
}
