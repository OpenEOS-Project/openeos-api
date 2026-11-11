import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiTokenAccess, CurrentUser } from '../../common/decorators';
import { User } from '../../database/entities';
import { TokenScope } from '../api-tokens/api-scopes';
import {
  CreateTokenTypeDto,
  TokenReportQueryDto,
  TokenTransactionQueryDto,
  UpdateTokenTypeDto,
} from './dto';
import { TokenTransactionsService } from './token-transactions.service';
import { TokenTypesService } from './token-types.service';

@ApiTags('Wertmarken')
@ApiParam({
  name: 'organizationId',
  description: 'ID der Organisation',
  format: 'uuid',
})
@ApiBearerAuth('JWT-auth')
@Controller('organizations/:organizationId')
export class TokenTypesController {
  constructor(
    private readonly tokenTypesService: TokenTypesService,
    private readonly tokenTransactionsService: TokenTransactionsService,
  ) {}

  @ApiTokenAccess(TokenScope.READ)
  @Get('token-types')
  @ApiOperation({
    operationId: 'listTokenTypes',
    summary: 'Markentypen (Wertmarken) auflisten',
    description:
      'Alle Markentypen der Organisation; mit `eventId` die der Veranstaltung und die organisationsweiten. `inUse` = schon verkauft oder angenommen (Nennwert/Art fest). Scope `read`.',
  })
  @ApiQuery({
    name: 'eventId',
    required: false,
    description: 'Nur Typen dieser Veranstaltung und die organisationsweiten',
  })
  async findAll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @CurrentUser() user: User,
    @Query('eventId', new ParseUUIDPipe({ optional: true })) eventId?: string,
  ) {
    return {
      data: await this.tokenTypesService.findAll(organizationId, user, eventId),
    };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Post('token-types')
  @ApiOperation({
    operationId: 'createTokenType',
    summary: 'Markentyp anlegen',
    description:
      'Mehrzweckgutschein (Standard) oder Einzweckgutschein (nur mit genau einem Steuersatz: 400 TOKEN_SINGLE_PURPOSE_MIXED_RATES, als Kleinunternehmer 400 TOKEN_SINGLE_PURPOSE_SMALL_BUSINESS). Kategorien/Artikel nur mit Veranstaltung (400 TOKEN_RESTRICTION_REQUIRES_EVENT). Recht „Produkte“, Scope `catalog:write`.',
  })
  async create(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateTokenTypeDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tokenTypesService.create(organizationId, dto, user),
    };
  }

  @ApiTokenAccess(TokenScope.CATALOG_WRITE)
  @Patch('token-types/:tokenTypeId')
  @ApiParam({ name: 'tokenTypeId', description: 'ID des Markentyps' })
  @ApiOperation({
    operationId: 'updateTokenType',
    summary: 'Markentyp ändern',
    description:
      'Sind schon Marken im Umlauf, bleiben Nennwert, Art, Satz und Artikelauswahl eines Einzweckgutscheins fest (409 TOKEN_TYPE_LOCKED). Name, Farbe, Aktiv, Rücktausch und Reihenfolge gehen immer.',
  })
  async update(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('tokenTypeId', ParseUUIDPipe) tokenTypeId: string,
    @Body() dto: UpdateTokenTypeDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tokenTypesService.update(
        organizationId,
        tokenTypeId,
        dto,
        user,
      ),
    };
  }

  @Delete('token-types/:tokenTypeId')
  @ApiParam({ name: 'tokenTypeId', description: 'ID des Markentyps' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'deleteTokenType',
    summary: 'Markentyp löschen',
    description:
      'Nur solange keine Marke verkauft oder angenommen wurde, sonst 409 TOKEN_TYPE_IN_USE (deaktivieren statt löschen).',
  })
  async remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('tokenTypeId', ParseUUIDPipe) tokenTypeId: string,
    @CurrentUser() user: User,
  ) {
    await this.tokenTypesService.remove(organizationId, tokenTypeId, user);
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('reports/tokens')
  @ApiOperation({
    operationId: 'getTokenReport',
    summary:
      'Wertmarken: verkauft, eingelöst, zurückgegeben, Rücktausch, im Umlauf',
    description:
      'Je Markentyp und je Veranstaltung, ohne Testbuchungen. Verkaufte Marken sind kein Umsatz (Mehrzweckgutschein: Umsatz entsteht bei der Einlösung). Recht „Berichte“ oder „Produkte“.',
  })
  async report(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: TokenReportQueryDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tokenTransactionsService.report(
        organizationId,
        user,
        query,
      ),
    };
  }

  @ApiTokenAccess(TokenScope.READ)
  @Get('token-transactions')
  @ApiOperation({
    operationId: 'listTokenTransactions',
    summary: 'Verkäufe und Rücktausch von Wertmarken',
    description: 'Neueste zuerst (höchstens `limit`, Standard 50).',
  })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: TokenTransactionQueryDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.tokenTransactionsService.list(
        organizationId,
        user,
        query,
      ),
    };
  }
}
