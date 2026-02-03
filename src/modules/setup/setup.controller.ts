import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SetupService, SetupResult } from './setup.service';
import { SetupDto } from './dto';

@ApiTags('Setup')
@Controller('setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Prüft ob die erstmalige Einrichtung erforderlich ist' })
  @ApiResponse({
    status: 200,
    description: 'Setup-Status',
    schema: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
  })
  async getSetupStatus(): Promise<{ required: boolean; reason?: string }> {
    return this.setupService.isSetupRequired();
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Führt die erstmalige Einrichtung durch',
    description: 'Zwei Modi verfügbar: "single" für Einzelbetrieb (Admin + Organisation mit unbegrenzten Credits), "multi" für Multi-Mandanten/SaaS (Super-Admin ohne Organisation)',
  })
  @ApiResponse({
    status: 201,
    description: 'Einrichtung erfolgreich',
  })
  @ApiResponse({ status: 400, description: 'Validierungsfehler' })
  @ApiResponse({ status: 409, description: 'Einrichtung bereits abgeschlossen' })
  async performSetup(@Body() setupDto: SetupDto): Promise<{
    message: string;
    mode: string;
    user: SetupResult['user'];
    organization?: SetupResult['organization'];
  }> {
    const result = await this.setupService.performSetup(setupDto);

    return {
      message: 'Einrichtung erfolgreich abgeschlossen',
      mode: result.mode,
      user: result.user,
      organization: result.organization,
    };
  }
}
