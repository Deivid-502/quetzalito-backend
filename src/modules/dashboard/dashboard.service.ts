import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { getMessage, getTip, Language } from '../../common/i18n/dashboard-messages';

export type AlertSeverity = 'info' | 'warning' | 'danger';

export interface DashboardAlert {
  type: string;
  message: string;
  severity: AlertSeverity;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(userId: string, year: number, month: number, language: Language = 'es') {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    const now = new Date();

    // ===== Lanzamos todas las queries en paralelo =====
    const [
      user,
      envelopes,
      monthAgg,
      categoryAgg,
      recentTransactions,
      budgets,
    ] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          nickname: true,
          firstName: true,
          isPremium: true,
          currencyCode: true,
        },
      }),
      this.prisma.envelope.findMany({
        where: { userId, archivedAt: null },
        orderBy: [{ isMain: 'desc' }, { currentBalance: 'desc' }],
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, occurredAt: { gte: start, lte: end } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.groupBy({
        by: ['categoryId'],
        where: {
          userId,
          type: 'expense',
          occurredAt: { gte: start, lte: end },
          categoryId: { not: null },
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
      }),
      this.prisma.transaction.findMany({
        where: { userId, occurredAt: { gte: start, lte: end } },
        orderBy: { occurredAt: 'desc' },
        take: 5,
        include: {
          envelope: { select: { id: true, name: true, icon: true, color: true } },
          category: { select: { id: true, name: true, icon: true, color: true } },
        },
      }),
      this.prisma.budget.findMany({
        where: { userId, periodYear: year, periodMonth: month },
        include: {
          category: { select: { id: true, name: true, icon: true, color: true } },
        },
      }),
    ]);

    // ===== Cálculos derivados =====
    const totalBalance = envelopes.reduce((s, e) => s + Number(e.currentBalance), 0);
    const monthIncome = this.sumByType(monthAgg, ['income']);
    const monthExpense = this.sumByType(monthAgg, ['expense']);
    const net = monthIncome - monthExpense;

    // Días restantes del mes (incluyendo hoy si es el mes actual)
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const lastDay = end.getDate();
    const daysLeft = isCurrentMonth
      ? Math.max(1, lastDay - now.getDate() + 1)
      : lastDay; // si es mes pasado/futuro, mostramos el límite "promedio diario" del mes completo

    const dailyLimit = totalBalance > 0 ? totalBalance / daysLeft : 0;
    const percentOfIncomeSpent = monthIncome > 0 ? (monthExpense / monthIncome) * 100 : 0;

    // ===== Breakdown por categoría (top 4 + "Otros") =====
    const categoryIds = categoryAgg.map((r) => r.categoryId).filter(Boolean) as string[];
    const categoryDetails = categoryIds.length
      ? await this.prisma.category.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, icon: true, color: true },
        })
      : [];
    const catMap = new Map(categoryDetails.map((c) => [c.id, c]));

    const TOP = 4;
    const breakdownTotal = categoryAgg.reduce(
      (s, r) => s + Number(r._sum.amount ?? 0),
      0,
    );

    const top = categoryAgg.slice(0, TOP);
    const rest = categoryAgg.slice(TOP);
    const restSum = rest.reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);

    const categoryBreakdown = top.map((r) => {
      const detail = catMap.get(r.categoryId!);
      const value = Number(r._sum.amount ?? 0);
      return {
        id: detail?.id ?? r.categoryId!,
        name: detail?.name ?? 'Categoría',
        icon: detail?.icon ?? 'circle-dot',
        color: detail?.color ?? '#6B7280',
        value,
        percent: breakdownTotal > 0 ? (value / breakdownTotal) * 100 : 0,
      };
    });

    if (restSum > 0) {
      categoryBreakdown.push({
        id: '__other__',
        name: 'Otros',
        icon: 'circle-dot',
        color: '#94A3B8',
        value: restSum,
        percent: breakdownTotal > 0 ? (restSum / breakdownTotal) * 100 : 0,
      });
    }

    // ===== Top sobres: principal + 3 con más saldo =====
    const main = envelopes.find((e) => e.isMain) ?? null;
    const others = envelopes.filter((e) => !e.isMain).slice(0, 3);
    const topEnvelopes = [main, ...others].filter(Boolean).map((e) => ({
      id: e!.id,
      name: e!.name,
      icon: e!.icon,
      color: e!.color,
      isMain: e!.isMain,
      currentBalance: Number(e!.currentBalance),
      targetAmount: e!.targetAmount ? Number(e!.targetAmount) : null,
      progress:
        e!.targetAmount && Number(e!.targetAmount) > 0
          ? Math.min(100, (Number(e!.currentBalance) / Number(e!.targetAmount)) * 100)
          : null,
    }));

    // ===== Presupuestos en alerta =====
    const spentByCat = new Map(
      categoryAgg.map((r) => [r.categoryId ?? '', Number(r._sum.amount ?? 0)]),
    );
    const budgetAlerts = budgets
      .map((b) => {
        const spent = spentByCat.get(b.categoryId) ?? 0;
        const limit = Number(b.amount);
        const percent = limit > 0 ? (spent / limit) * 100 : 0;
        const status: 'ok' | 'alert' | 'exceeded' =
          percent >= 100 ? 'exceeded' : percent >= 90 ? 'alert' : 'ok';
        return { b, spent, limit, percent, status };
      })
      .filter((x) => x.status !== 'ok')
      .map((x) => ({
        category: x.b.category,
        limit: x.limit,
        spent: x.spent,
        percent: x.percent,
        status: x.status,
      }));

    // ===== Alertas inteligentes =====
    const alerts = this.computeAlerts({
      monthIncome,
      monthExpense,
      mainBalance: main ? Number(main.currentBalance) : 0,
      envelopeCount: envelopes.length,
      hasBudgets: budgets.length > 0,
      budgetAlerts,
      isCurrentMonth,
    });

    // ===== Tip contextual =====
    const tip = this.pickTip({
      hasNoTransactions: monthExpense === 0 && monthIncome === 0,
      noBudgets: budgets.length === 0,
      hasSurplus: net > 0,
      others: others.length,
    }, language);

    return {
      user: {
        nickname: user.nickname,
        firstName: user.firstName,
        isPremium: user.isPremium,
        currencyCode: user.currencyCode,
      },
      period: { year, month },
      balance: {
        total: totalBalance,
        monthIncome,
        monthExpense,
        net,
      },
      dailyLimit: {
        value: dailyLimit,
        daysLeft,
        percentSpent: Math.min(100, percentOfIncomeSpent),
        isCurrentMonth,
      },
      categoryBreakdown,
      categoryBreakdownTotal: breakdownTotal,
      recentTransactions: recentTransactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        description: t.description,
        occurredAt: t.occurredAt,
        envelope: t.envelope,
        category: t.category,
      })),
      topEnvelopes,
      budgetAlerts,
      alerts,
      tip,
    };
  }

  // =========================================================
  //  HELPERS
  // =========================================================
  private sumByType(
    rows: { type: string; _sum: { amount: Prisma.Decimal | null } }[],
    types: string[],
  ): number {
    return rows
      .filter((r) => types.includes(r.type))
      .reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
  }

  private computeAlerts(input: {
    monthIncome: number;
    monthExpense: number;
    mainBalance: number;
    envelopeCount: number;
    hasBudgets: boolean;
    budgetAlerts: { category: { name: string }; status: string }[];
    isCurrentMonth: boolean;
  }): DashboardAlert[] {
    const alerts: DashboardAlert[] = [];

    if (!input.isCurrentMonth) return alerts; // no alertar para meses pasados

    // Ratio de gasto vs ingresos
    const ratio = input.monthIncome > 0 ? input.monthExpense / input.monthIncome : 0;

    if (input.monthExpense > input.monthIncome && input.monthIncome > 0) {
      alerts.push({
        type: 'overspend',
        severity: 'danger',
        message: 'Este mes gastaste más de lo que ingresaste. Revisá en qué se fue tu dinero.',
      });
    } else if (ratio >= 0.8) {
      alerts.push({
        type: 'high_spend',
        severity: 'warning',
        message: getMessage('spendingWarning', language),
      });
    }

    if (input.mainBalance > 0 && input.mainBalance < 100) {
      alerts.push({
        type: 'low_main',
        severity: 'warning',
        message: language === 'es' 
          ? 'Tu cuenta principal está casi vacía. Considerá mover dinero desde otro sobre.'
          : 'Your main account is almost empty. Consider moving money from another envelope.',
      });
    }

    const exceeded = input.budgetAlerts.filter((b) => b.status === 'exceeded');
    if (exceeded.length > 0) {
      alerts.push({
        type: 'budget_exceeded',
        severity: 'danger',
        message:
          exceeded.length === 1
            ? getMessage('budgetExceededSingle', language, exceeded[0].category.name)
            : getMessage('budgetExceededMultiple', language, exceeded.length),
      });
    }

    if (input.envelopeCount === 1) {
      alerts.push({
        type: 'no_envelopes',
        severity: 'info',
        message: language === 'es'
          ? 'Creá un sobre para separar tus gastos por propósito y tener mejor control.'
          : 'Create an envelope to separate your expenses by purpose and have better control.',
      });
    } else if (!input.hasBudgets) {
      alerts.push({
        type: 'no_budgets',
        severity: 'info',
        message: getMessage('defineBudgets', language),
      });
    }

    return alerts;
  }

  private pickTip(ctx: {
    hasNoTransactions: boolean;
    noBudgets: boolean;
    hasSurplus: boolean;
    others: number;
  }, language: Language = 'es'): { title: string; text: string } {
    const tips = {
      es: {
        noTransactions: {
          title: 'Empezá registrando',
          text: 'Anotá tu primer movimiento del mes para empezar a ver dónde va tu dinero.',
        },
        noOthers: {
          title: 'Organizá en sobres',
          text: 'Crear un sobre para Comida y otro para Ahorro te ayudará a ver mejor tu plata.',
        },
        noBudgets: {
          title: 'Definí límites',
          text: 'Un presupuesto te dice cuánto podés gastar. Empezá con uno: Comida o Transporte.',
        },
        surplus: {
          title: 'Pagate primero',
          text: 'Apenas te entra dinero, mové una parte a un sobre de ahorro antes de gastarlo.',
        },
        generic: [
          {
            title: 'Regla 50/30/20',
            text: 'Destiná 50% a necesidades, 30% a deseos y 20% al ahorro o pago de deudas.',
          },
          {
            title: 'Anotá lo pequeño',
            text: 'Los gastos chiquitos suman más de lo que pensás. Registralos al instante.',
          },
          {
            title: 'Antojo de 24 horas',
            text: 'Antes de comprar algo no esencial, esperá 24 horas. Vas a ver si lo seguís queriendo.',
          },
        ],
      },
      en: {
        noTransactions: {
          title: 'Start recording',
          text: 'Write down your first movement of the month to start seeing where your money goes.',
        },
        noOthers: {
          title: 'Organize in envelopes',
          text: 'Create an envelope for Food and another for Savings to see your money better.',
        },
        noBudgets: {
          title: 'Set limits',
          text: 'A budget tells you how much you can spend. Start with one: Food or Transportation.',
        },
        surplus: {
          title: 'Pay yourself first',
          text: 'As soon as money comes in, move a portion to a savings envelope before spending it.',
        },
        generic: [
          {
            title: '50/30/20 Rule',
            text: 'Allocate 50% to needs, 30% to wants, and 20% to savings or debt payments.',
          },
          {
            title: 'Record the small stuff',
            text: 'Small expenses add up more than you think. Register them instantly.',
          },
          {
            title: '24-hour rule',
            text: 'Before buying something non-essential, wait 24 hours. See if you still want it.',
          },
        ],
      },
    };

    const t = tips[language];
    
    if (ctx.hasNoTransactions) return t.noTransactions;
    if (ctx.others === 0) return t.noOthers;
    if (ctx.noBudgets) return t.noBudgets;
    if (ctx.hasSurplus) return t.surplus;
    
    return t.generic[new Date().getDate() % t.generic.length];
  }
}
