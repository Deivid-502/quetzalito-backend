import { Injectable, NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        nickname: true,
        phone: true,
        avatarUrl: true,
        isPremium: true,
        currencyCode: true,
        language: true,
        theme: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        nickname: dto.nickname,
        phone: dto.phone,
        // dto.avatarUrl puede ser:
        //   · string → setea
        //   · null   → borra (Prisma traduce a UPDATE ... SET avatar_url = NULL)
        //   · undefined → no cambia
        avatarUrl: dto.avatarUrl,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        nickname: true,
        phone: true,
        avatarUrl: true,
      },
    });
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        language: dto.language,
        currencyCode: dto.currencyCode,
        theme: dto.theme,
      },
      select: {
        language: true,
        currencyCode: true,
        theme: true,
      },
    });
  }

  /**
   * Cambio de contraseña con verificación de la actual.
   * Por seguridad: si la actual no coincide → UnauthorizedException.
   * Invalida todos los refresh tokens del usuario para forzar re-login en otros dispositivos.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const ok = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!ok) {
      throw new UnauthorizedException('La contraseña actual es incorrecta.');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual.');
    }

    const newHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });

    // Cambiamos password e invalidamos todas las sesiones activas
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { ok: true };
  }
}
