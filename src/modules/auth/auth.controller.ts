import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { RequestSensitiveCodeDto } from './dto/request-sensitive-code.dto';
import { VerifySensitiveCodeDto } from './dto/verify-sensitive-code.dto';
import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma/prisma.service';

const ACCESS_COOKIE = 'qz_access';
const REFRESH_COOKIE = 'qz_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  // =========================================================
  //  POST /api/auth/register
  // =========================================================
  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return { user: result.user };
  }

  // =========================================================
  //  POST /api/auth/login
  // =========================================================
  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, result.tokens.accessToken, result.tokens.refreshToken);
    return { user: result.user };
  }

  // =========================================================
  //  POST /api/auth/refresh
  // =========================================================
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    const tokens = await this.auth.refresh(refreshToken, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return { ok: true };
  }

  // =========================================================
  //  POST /api/auth/logout
  // =========================================================
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    await this.auth.logout(refreshToken);
    this.clearAuthCookies(res);
  }

  // =========================================================
  //  GET /api/auth/me
  // =========================================================
  @Get('me')
  async me(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: current.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        nickname: true,
        avatarUrl: true,
        phone: true,
        isPremium: true,
        currencyCode: true,
        language: true,
        theme: true,
        emailVerifiedAt: true,
      },
    });
    return { user };
  }

  // =========================================================
  //  POST /api/auth/verify-email/send
  //  Reenviar código de verificación de email
  // =========================================================
  @Post('verify-email/send')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async sendVerification(@CurrentUser() current: AuthenticatedUser) {
    await this.auth.sendEmailVerification(current.sub);
  }

  // =========================================================
  //  POST /api/auth/verify-email/confirm
  //  Confirmar con el código recibido
  // =========================================================
  @Post('verify-email/confirm')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEmail(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: VerifyCodeDto,
  ) {
    await this.auth.verifyEmail(current.sub, dto.code);
  }

  // =========================================================
  //  POST /api/auth/sensitive/request
  //  Solicitar código 2FA para cambio sensible
  // =========================================================
  @Post('sensitive/request')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestSensitiveCode(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: RequestSensitiveCodeDto,
  ) {
    await this.auth.requestSensitiveCode(current.sub, dto.purpose);
  }

  // =========================================================
  //  POST /api/auth/sensitive/verify
  //  Verificar código 2FA — devuelve un token de un solo uso
  // =========================================================
  @Post('sensitive/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async verifySensitiveCode(
    @CurrentUser() current: AuthenticatedUser,
    @Body() dto: VerifySensitiveCodeDto,
  ) {
    await this.auth.verifySensitiveCode(current.sub, dto.code, dto.purpose);
    return { verified: true, purpose: dto.purpose };
  }

  // =========================================================
  //  Cookie helpers
  // =========================================================
  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const secure = !!this.config.get<boolean>('cookies.secure');
    const domain = this.config.get<string>('cookies.domain');

    res.cookie(ACCESS_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      domain,
      path: '/',
      maxAge: 1000 * 60 * 15, // 15 min
    });

    res.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      domain,
      path: '/api/auth',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    });
  }

  private clearAuthCookies(res: Response) {
    const domain = this.config.get<string>('cookies.domain');
    res.clearCookie(ACCESS_COOKIE, { domain, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { domain, path: '/api/auth' });
  }
}
