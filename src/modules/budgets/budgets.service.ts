import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';
import { UpsertBudgetDto, UpdateBudgetAmountDto } from './dto/upsert-budget.dto';

export type BudgetStatus = 'unset' | 'ok' | 'warning' | 'alert' | 'exceeded';

@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================
  //  LIST por periodo + progreso real
  // =========================================================
  async listForPeriod(userId: string, year: number, month: number) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    const [categories, budgets, spentAgg] = await Promise.all([
      // Categorías de gasto disponibles para el usuario
      this.prisma.category.findMany({
        where: {
          OR: [{ isSystem: true }, { userId }],
          type: { in: ['expense', 'both'] },
        },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      }),
      // Presupuestos del periodo
      this.prisma.budget.findMany({
        where: { userId, periodYear: year, periodMonth: month },
      }),
      // Gasto agregado por categoría en el periodo
      this.prisma.transaction.groupBy({
        by: ['categoryId'],
        where: {
          userId,
          type: 'expense',
          occurredAt: { gte: start, lte: end },
        },
        _sum: { amount: true },
      }),
    ]);

    const budgetByCat = new Map(budgets.map((b) => [b.categoryId, b]));
    const spentByCat = new Map(
      spentAgg.map((r) => [r.categoryId ?? '', Number(r._sum.amount ?? 0)]),
    );

    const items = categories.map((cat) => {
      const budget = budgetByCat.get(cat.id);
      const limit = budget ? Number(budget.amount) : 0;
      const spent = spentByCat.get(cat.id) ?? 0;
      const percent = limit > 0 ? (spent / limit) * 100 : 0;
      return {
        category: {
          id: cat.id,
          name: cat.name,
          icon: cat.icon,
          color: cat.color,
          type: cat.type,
          isSystem: cat.isSystem,
        },
        budgetId: budget?.id ?? null,
        limit,
        spent,
        remaining: Math.max(0, limit - spent),
        percent,
        status: this.computeStatus(limit, spent),
      };
    });

    // Agregados globales
    const totalBudgeted = budgets.reduce((s, b) => s + Number(b.amount), 0);
    const totalSpent = items.reduce((s, i) => s + i.spent, 0);

    return {
      period: { year, month },
      totals: {
        budgeted: totalBudgeted,
        spent: totalSpent,
        remaining: Math.max(0, totalBudgeted - totalSpent),
        percent: totalBudgeted > 0 ? (totalSpent / totalBudgeted) * 100 : 0,
      },
      items,
    };
  }

  // =========================================================
  //  UPSERT  (crea o actualiza por user+category+periodo)
  // =========================================================
  async upsert(userId: string, dto: UpsertBudgetDto) {
    // La categoría debe existir, ser de gasto y ser accesible al usuario
    const cat = await this.prisma.category.findFirst({
      where: {
        id: dto.categoryId,
        OR: [{ isSystem: true }, { userId }],
        type: { in: ['expense', 'both'] },
      },
    });
    if (!cat) {
      throw new NotFoundException('Categoría de gasto no encontrada.');
    }

    return this.prisma.budget.upsert({
      where: {
        userId_categoryId_periodYear_periodMonth: {
          userId,
          categoryId: dto.categoryId,
          periodYear: dto.periodYear,
          periodMonth: dto.periodMonth,
        },
      },
      create: {
        userId,
        categoryId: dto.categoryId,
        amount: dto.amount,
        periodYear: dto.periodYear,
        periodMonth: dto.periodMonth,
      },
      update: {
        amount: dto.amount,
      },
    });
  }

  async updateAmount(userId: string, id: string, dto: UpdateBudgetAmountDto) {
    const existing = await this.prisma.budget.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('Presupuesto no encontrado.');
    return this.prisma.budget.update({
      where: { id },
      data: { amount: dto.amount },
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.prisma.budget.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('Presupuesto no encontrado.');
    await this.prisma.budget.delete({ where: { id } });
    return { ok: true };
  }

  // =========================================================
  //  HELPERS
  // =========================================================
  private computeStatus(limit: number, spent: number): BudgetStatus {
    if (limit <= 0) return 'unset';
    const pct = (spent / limit) * 100;
    if (pct >= 100) return 'exceeded';
    if (pct >= 90) return 'alert';
    if (pct >= 70) return 'warning';
    return 'ok';
  }
}
