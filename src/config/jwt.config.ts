import { registerAs } from '@nestjs/config';

export interface JwtConfig {
  secret: string;
  accessTokenExpiration: string;
  refreshTokenExpiration: string;
}

export default registerAs(
  'jwt',
  (): JwtConfig => ({
    // No fallback here on purpose: JWT_SECRET is Joi.required() in
    // validation.schema.ts, so the app already refuses to boot without it —
    // a fallback would only ever matter if that validation were loosened or
    // reordered, in which case it'd silently become the live signing key.
    secret: process.env.JWT_SECRET as string,
    accessTokenExpiration: process.env.JWT_ACCESS_TOKEN_EXPIRATION || '30m',
    refreshTokenExpiration: process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d',
  }),
);
