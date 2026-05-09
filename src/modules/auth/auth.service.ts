import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../../database/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    nickname: string;
    avatarUrl: string | null;
    isPremium: boolean;
    currencyCode: string;
    language: string;
    theme: string;
  };
  tokens: AuthTokens;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // =========================================================
  //  REGISTRO
  // =========================================================
  async register(dto: RegisterDto, meta: { ip?: string; userAgent?: string }): Promise<AuthResult> {
    const emailNormalized = dto.email.trim().toLowerCase();

    const exists = await this.prisma.user.findUnique({ where: { email: emailNormalized } });
    if (exists) {
      throw new ConflictException('Ya existe una cuenta con ese correo.');
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // Creamos usuario + alcancía principal en una sola transacción
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: emailNormalized,
          passwordHash,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          nickname: dto.nickname.trim(),
          phone: dto.phone?.trim(),
        },
      });

      // Alcancía principal por defecto
      await tx.envelope.create({
        data: {
          userId: created.id,
          name: 'Cuenta principal',
          description: 'Tu alcancía principal donde se mueve tu dinero diario.',
          icon: '💰',
          color: '#10B981',
          isMain: true,
          currentBalance: 0,
        },
      });

      // Suscripción Free activa
      await tx.subscription.create({
        data: {
          userId: created.id,
          plan: 'free',
          status: 'active',
          startsAt: new Date(),
        },
      });

      return created;
    });

    const tokens = await this.issueTokens(user.id, user.email, meta);

    return { user: this.toPublicUser(user), tokens };
  }

  // =========================================================
  //  LOGIN
  // =========================================================
  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<AuthResult> {
    const emailNormalized = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({ where: { email: emailNormalized } });
    // Mensaje genérico para no filtrar si el correo existe o no
    const invalid = new UnauthorizedException('Correo o contraseña inválidos.');

    if (!user) {
      // Aún así hacemos un hash dummy para evitar timing attacks
      await argon2.hash('dummy-password-for-timing');
      throw invalid;
    }

    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) throw invalid;

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.email, meta);
    return { user: this.toPublicUser(user), tokens };
  }

  // =========================================================
  //  REFRESH (rotación)
  // =========================================================
  async refresh(refreshToken: string, meta: { ip?: string; userAgent?: string }): Promise<AuthTokens> {
    if (!refreshToken) throw new UnauthorizedException('Sesión expirada.');

    let payload: { sub: string; email: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Sesión expirada.');
    }

    const tokenHash = this.hashToken(refreshToken);

    const stored = await this.prisma.refreshToken.findFirst({
      where: {
        userId: payload.sub,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!stored) {
      // Posible reuse → invalidamos toda la familia
      await this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sesión inválida.');
    }

    // Rotación: revocamos el actual y emitimos uno nuevo
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(payload.sub, payload.email, meta);
  }

  // =========================================================
  //  LOGOUT
  // =========================================================
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // =========================================================
  //  HELPERS
  // =========================================================
  private async issueTokens(
    userId: string,
    email: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      {
        secret: this.config.get<string>('jwt.accessSecret'),
        expiresIn: this.config.get<string>('jwt.accessExpiresIn'),
      },
    );

    // Refresh con jti aleatorio para que cada uno sea único aunque se emita en el mismo seg.
    const jti = randomBytes(16).toString('hex');
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, email, jti },
      {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<string>('jwt.refreshExpiresIn'),
      },
    );

    const tokenHash = this.hashToken(refreshToken);
    const decoded = this.jwt.decode(refreshToken) as { exp: number };
    const expiresAt = new Date(decoded.exp * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublicUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    nickname: string;
    avatarUrl: string | null;
    isPremium: boolean;
    currencyCode: string;
    language: string;
    theme: string;
  }): AuthResult['user'] {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      isPremium: user.isPremium,
      currencyCode: user.currencyCode,
      language: user.language,
      theme: user.theme,
    };
  }
}
