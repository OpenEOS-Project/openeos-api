import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppGateway } from './app.gateway';
import { GatewayService } from './gateway.service';
import { DevicesModule } from '../devices';
import { PrintersModule } from '../printers';
import { PrintJobsModule } from '../print-jobs';
import { UserOrganization } from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserOrganization]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
      }),
      inject: [ConfigService],
    }),
    forwardRef(() => DevicesModule),
    forwardRef(() => PrintersModule),
    forwardRef(() => PrintJobsModule),
  ],
  providers: [AppGateway, GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
