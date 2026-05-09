import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';

import { PrismaService } from '../../../database/prisma/prisma.service';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

interface JwtPayload {
  sub: string;
  email: string;
}

const cookieExtractor = (req: Request): string | null => {
  if (req && req.cookies && typeof req.cookies['qz_access'] === 'string') {
    return req.cookies['qz_access'];
  }
  return null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      // Aceptamos token desde cookie HttpOnly Y como fallback el header (útil para tools)
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, isPremium: true },
    });

    if (!user) {
      throw new UnauthorizedException('Sesión no válida.');
    }

    return {
      sub: user.id,
      email: user.email,
      isPremium: user.isPremium,
    };
  }
}
