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
import { SetupService } from './setup.service';
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
  @ApiOperation({ summary: 'Führt die erstmalige Einrichtung durch' })
  @ApiResponse({
    status: 201,
    description: 'Einrichtung erfolgreich',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
          },
        },
        organization: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 409, description: 'Einrichtung bereits abgeschlossen' })
  async performSetup(@Body() setupDto: SetupDto): Promise<{
    message: string;
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    };
    organization: {
      id: string;
      name: string;
      slug: string;
    };
  }> {
    const result = await this.setupService.performSetup(setupDto);

    return {
      message: 'Einrichtung erfolgreich abgeschlossen',
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
      },
      organization: {
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
      },
    };
  }
}
