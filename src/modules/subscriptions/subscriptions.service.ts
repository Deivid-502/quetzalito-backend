import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';

const PREMIUM_DURATION_DAYS = 30;
const PREMIUM_PRICE_GTQ = 19;

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Estado de suscripción del usuario actual.
   * Devuelve el plan actual y la suscripción activa más reciente, si la hay.
   */
  async getStatus(userId: string) {
    const [user, active] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { isPremium: true, currencyCode: true },
      }),
      this.prisma.subscription.findFirst({
        where: { userId, status: 'active' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      currentPlan: user.isPremium ? 'premium' : 'free',
      isPremium: user.isPremium,
      pricing: {
        amount: PREMIUM_PRICE_GTQ,
        currency: 'GTQ',
        intervalDays: PREMIUM_DURATION_DAYS,
      },
      activeSubscription: active
        ? {
            id: active.id,
            plan: active.plan,
            status: active.status,
            startsAt: active.startsAt,
            endsAt: active.endsAt,
          }
        : null,
    };
  }

  /**
   * Activación simulada de Premium (sin pasarela real).
   * En producción acá se integra Stripe / PayU / Recurly via webhook.
   */
  async activatePremium(userId: string) {
    // Si ya es premium activo, evitamos doble cobro / doble registro
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { isPremium: true },
    });
    if (user.isPremium) {
      throw new BadRequestException('Ya tenés Premium activo.');
    }

    const now = new Date();
    const endsAt = new Date(now);
    endsAt.setDate(endsAt.getDate() + PREMIUM_DURATION_DAYS);

    const [, subscription] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { isPremium: true },
      }),
      this.prisma.subscription.create({
        data: {
          userId,
          plan: 'premium',
          status: 'active',
          startsAt: now,
          endsAt,
          paymentProvider: 'simulated',
          paymentReference: `sim_${now.getTime()}`,
        },
      }),
    ]);

    return {
      ok: true,
      subscription: {
        id: subscription.id,
        plan: subscription.plan,
        status: subscription.status,
        startsAt: subscription.startsAt,
        endsAt: subscription.endsAt,
      },
    };
  }

  /**
   * Cancela la suscripción activa.
   * Política simple para MVP: marca cancelada Y baja el flag isPremium inmediatamente.
   * En producción real se mantendría isPremium hasta endsAt y un cron lo bajaría al expirar.
   */
  async cancelPremium(userId: string) {
    const active = await this.prisma.subscription.findFirst({
      where: { userId, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) {
      throw new NotFoundException('No tenés ninguna suscripción activa.');
    }

    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: active.id },
        data: { status: 'cancelled', endsAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { isPremium: false },
      }),
    ]);

    return { ok: true };
  }
}
