import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './services/token.service';
import { OtpService } from './services/otp.service';
import { OneIdService } from './services/oneid.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RolesGuard } from './guards/roles.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    HttpModule.register({ timeout: 10_000, maxRedirects: 0 }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          // See TokenService: `ms` types this as a template literal, which a
          // runtime config string cannot satisfy statically.
          expiresIn: config.get<string>(
            'ACCESS_TOKEN_TTL',
            '15m',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    OneIdService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
  ],
  // JwtModule is re-exported so AdminModule can sign impersonation tokens with
  // the same configured secret, issuer, and audience rather than assembling its
  // own signer that could drift from this one.
  exports: [AuthService, TokenService, JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
