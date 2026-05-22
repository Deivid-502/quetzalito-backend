import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
  TooManyRequestsException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../../database/prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { AuditService } from '../../common/audit/audit.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

// Cuántos minutos tiene validez un código
const CODE_TTL_MIN = 10;
// Cooldown mínimo entre reenvíos (segundos)
const RESEND_COOLDOWN_SEC = 60;
// Máximo de intentos fallidos antes de invalidar el código
const MAX_ATTEMPTS = 5;

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
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
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

    void this.audit.log({ userId: user.id, action: 'AUTH_REGISTER', status: 'ok', ...meta });

    // Enviar verificación de email en background (no bloquea la respuesta)
    this.sendEmailVerification(user.id).catch((err) =>
      this.logger.error(`Error enviando verificación a ${user.email}: ${err}`),
    );

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
      await argon2.hash('dummy-password-for-timing');
      void this.audit.log({ action: 'AUTH_LOGIN_FAIL', status: 'fail', meta: { reason: 'user_not_found' }, ...meta });
      throw invalid;
    }

    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) {
      void this.audit.log({ userId: user.id, action: 'AUTH_LOGIN_FAIL', status: 'fail', meta: { reason: 'wrong_password' }, ...meta });
      throw invalid;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.email, meta);
    void this.audit.log({ userId: user.id, action: 'AUTH_LOGIN', status: 'ok', ...meta });
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
  //  VERIFICACIÓN DE EMAIL
  // =========================================================
  async sendEmailVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, language: true },
    });

    if (user.emailVerifiedAt) return; // Ya verificado

    // Cooldown: si ya hay un código reciente, no reenviar
    const recent = await this.prisma.verificationCode.findFirst({
      where: {
        userId,
        purpose: 'email_verify',
        consumedAt: null,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_SEC * 1000) },
      },
    });

    if (recent) {
      throw new TooManyRequestsException(
        `Esperá ${RESEND_COOLDOWN_SEC} segundos antes de solicitar otro código.`,
      );
    }

    // Invalidar códigos anteriores del mismo propósito
    await this.prisma.verificationCode.updateMany({
      where: { userId, purpose: 'email_verify', consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const { plain, hashed } = this.generateCode();

    await this.prisma.verificationCode.create({
      data: {
        userId,
        codeHash: hashed,
        purpose: 'email_verify',
        expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60 * 1000),
      },
    });

    const lang = (user.language === 'en' ? 'en' : 'es') as 'es' | 'en';
    await this.mailer.sendEmailVerification(user.email, plain, lang);
  }

  async verifyEmail(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });

    if (user.emailVerifiedAt) return;

    try {
      await this.consumeCode(userId, 'email_verify', code);
      await this.prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });
      void this.audit.log({ userId, action: 'EMAIL_VERIFY_CONFIRM', status: 'ok' });
    } catch (err) {
      void this.audit.log({ userId, action: 'EMAIL_VERIFY_FAIL', status: 'fail' });
      throw err;
    }
  }

  // =========================================================
  //  CÓDIGOS PARA ACCIONES SENSIBLES (2FA ligero)
  // =========================================================
  async requestSensitiveCode(
    userId: string,
    purpose: 'change_password' | 'change_email',
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, language: true },
    });

    // Cooldown por propósito
    const recent = await this.prisma.verificationCode.findFirst({
      where: {
        userId,
        purpose,
        consumedAt: null,
        createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_SEC * 1000) },
      },
    });

    if (recent) {
      throw new TooManyRequestsException(
        `Esperá ${RESEND_COOLDOWN_SEC} segundos antes de solicitar otro código.`,
      );
    }

    // Invalidar anteriores
    await this.prisma.verificationCode.updateMany({
      where: { userId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const { plain, hashed } = this.generateCode();

    await this.prisma.verificationCode.create({
      data: {
        userId,
        codeHash: hashed,
        purpose,
        expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60 * 1000),
      },
    });

    const lang = (user.language === 'en' ? 'en' : 'es') as 'es' | 'en';
    await this.mailer.sendSensitiveCode(user.email, plain, purpose, lang);
  }

  async verifySensitiveCode(
    userId: string,
    code: string,
    purpose: 'change_password' | 'change_email',
  ): Promise<void> {
    try {
      await this.consumeCode(userId, purpose, code);
      void this.audit.log({ userId, action: 'SENSITIVE_CODE_VERIFY', status: 'ok', meta: { purpose } });
    } catch (err) {
      void this.audit.log({ userId, action: 'SENSITIVE_CODE_FAIL', status: 'fail', meta: { purpose } });
      throw err;
    }
  }

  // =========================================================
  //  HELPERS PRIVADOS
  // =========================================================
  private generateCode(): { plain: string; hashed: string } {
    const plain = String(Math.floor(100000 + Math.random() * 900000));
    const hashed = createHash('sha256').update(plain).digest('hex');
    return { plain, hashed };
  }

  private async consumeCode(userId: string, purpose: string, code: string): Promise<void> {
    const hashed = createHash('sha256').update(code).digest('hex');

    const record = await this.prisma.verificationCode.findFirst({
      where: {
        userId,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.codeHash !== hashed) {
      throw new BadRequestException('Código inválido o expirado.');
    }

    await this.prisma.verificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  }
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
