import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SetupService, SetupResult, SetupStatus } from './setup.service';
import { SetupDto } from './dto';

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({
    summary: 'Prüft ob die erstmalige Einrichtung erforderlich ist',
  })
  @ApiResponse({
    status: 200,
    description: 'Setup-Status',
    schema: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        reason: { type: 'string' },
        tokenRequired: { type: 'boolean' },
      },
    },
  })
  async getSetupStatus(): Promise<SetupStatus> {
    return this.setupService.isSetupRequired();
  }

  @Public()
  @Post()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'X-Setup-Token',
    required: true,
    description:
      'Einrichtungscode: Wert aus `SETUP_TOKEN` oder, ohne diese Variable, der Code, den die API beim ersten Start ins Protokoll schreibt. Falsch oder fehlend → 403 SETUP_TOKEN_INVALID.',
  })
  @ApiOperation({
    summary: 'Führt die erstmalige Einrichtung durch',
    description:
      'Zwei Modi verfügbar: "single" für Einzelbetrieb (Admin + Organisation; mit DEPLOYMENT_MODE=selfhosted ohne Abrechnung), "multi" für Multi-Mandanten/SaaS (Super-Admin ohne Organisation, Freischaltung je Veranstaltungstag)',
  })
  @ApiResponse({
    status: 201,
    description: 'Einrichtung erfolgreich',
  })
  @ApiResponse({ status: 400, description: 'Validierungsfehler' })
  @ApiResponse({
    status: 403,
    description: 'Einrichtungscode fehlt oder ist falsch',
  })
  @ApiResponse({
    status: 409,
    description: 'Einrichtung bereits abgeschlossen',
  })
  async performSetup(
    @Body() setupDto: SetupDto,
    @Headers('x-setup-token') setupToken?: string,
  ): Promise<{
    message: string;
    mode: string;
    user: SetupResult['user'];
    organization?: SetupResult['organization'];
  }> {
    const result = await this.setupService.performSetup(setupDto, setupToken);

    return {
      message: 'Einrichtung erfolgreich abgeschlossen',
      mode: result.mode,
      user: result.user,
      organization: result.organization,
    };
  }
}
