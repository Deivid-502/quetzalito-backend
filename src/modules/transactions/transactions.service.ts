import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================
  //  CREATE  (income | expense)
  //  Las transferencias se crean por EnvelopesService.transfer
  // =========================================================
  async create(userId: string, dto: CreateTransactionDto) {
    return this.prisma.$transaction(async (tx) => {
      const envelope = await tx.envelope.findFirst({
        where: { id: dto.envelopeId, userId, archivedAt: null },
      });
      if (!envelope) {
        throw new NotFoundException('Sobre no encontrado o archivado.');
      }

      if (dto.categoryId) {
        const cat = await tx.category.findFirst({
          where: {
            id: dto.categoryId,
            OR: [{ isSystem: true }, { userId }],
          },
        });
        if (!cat) throw new NotFoundException('Categoría no encontrada.');
        // Validar que la categoría aplica al tipo
        if (cat.type !== 'both' && cat.type !== dto.type) {
          throw new BadRequestException(
            `La categoría "${cat.name}" no es válida para ${dto.type === 'income' ? 'ingresos' : 'gastos'}.`,
          );
        }
      }

      // Aplicar al saldo del sobre
      const delta = dto.type === 'income' ? dto.amount : -dto.amount;
      await tx.envelope.update({
        where: { id: envelope.id },
        data: { currentBalance: { increment: delta } },
      });

      const created = await tx.transaction.create({
        data: {
          userId,
          envelopeId: dto.envelopeId,
          categoryId: dto.categoryId,
          type: dto.type,
          amount: dto.amount,
          description: dto.description,
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        },
        include: this.includeRefs(),
      });

      return this.toPublic(created);
    });
  }

  // =========================================================
  //  UPDATE  (revert + reapply)
  //  No se permiten editar transferencias (solo se eliminan).
  // =========================================================
  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findFirst({
        where: { id, userId },
      });
      if (!existing) throw new NotFoundException('Movimiento no encontrado.');
      if (existing.type === 'transfer_in' || existing.type === 'transfer_out') {
        throw new ForbiddenException(
          'Las transferencias entre sobres no se pueden editar. Eliminá esta y creá una nueva.',
        );
      }

      const newType = dto.type ?? (existing.type as 'income' | 'expense');
      const newAmount = dto.amount ?? Number(existing.amount);
      const newEnvelopeId = dto.envelopeId ?? existing.envelopeId;

      // Validaciones del nuevo destino
      const newEnvelope = await tx.envelope.findFirst({
        where: { id: newEnvelopeId, userId, archivedAt: null },
      });
      if (!newEnvelope) {
        throw new NotFoundException('Sobre destino no encontrado o archivado.');
      }

      if (dto.categoryId !== undefined && dto.categoryId !== null) {
        const cat = await tx.category.findFirst({
          where: {
            id: dto.categoryId,
            OR: [{ isSystem: true }, { userId }],
          },
        });
        if (!cat) throw new NotFoundException('Categoría no encontrada.');
        if (cat.type !== 'both' && cat.type !== newType) {
          throw new BadRequestException(
            `La categoría "${cat.name}" no aplica a ${newType === 'income' ? 'ingresos' : 'gastos'}.`,
          );
        }
      }

      // 1) Revertir efecto previo en el sobre original
      const oldDelta =
        existing.type === 'income' ? -Number(existing.amount) : Number(existing.amount);
      await tx.envelope.update({
        where: { id: existing.envelopeId },
        data: { currentBalance: { increment: oldDelta } },
      });

      // 2) Aplicar nuevo efecto en el sobre destino
      const newDelta = newType === 'income' ? newAmount : -newAmount;
      await tx.envelope.update({
        where: { id: newEnvelopeId },
        data: { currentBalance: { increment: newDelta } },
      });

      // 3) Persistir cambios
      const updated = await tx.transaction.update({
        where: { id },
        data: {
          type: newType,
          amount: newAmount,
          envelopeId: newEnvelopeId,
          categoryId: dto.categoryId === null ? null : dto.categoryId ?? existing.categoryId,
          description: dto.description ?? existing.description,
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : existing.occurredAt,
        },
        include: this.includeRefs(),
      });

      return this.toPublic(updated);
    });
  }

  // =========================================================
  //  DELETE  (revert)
  //  Si es transferencia, elimina ambos lados y revierte ambos.
  // =========================================================
  async remove(userId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findFirst({
        where: { id, userId },
      });
      if (!existing) throw new NotFoundException('Movimiento no encontrado.');

      if (existing.type === 'transfer_in' || existing.type === 'transfer_out') {
        // Eliminar el par completo
        const pair = existing.relatedTransactionId
          ? await tx.transaction.findUnique({ where: { id: existing.relatedTransactionId } })
          : null;

        // Revertir ambos lados
        // transfer_out: dinero salió → al borrar le devolvemos al origen
        // transfer_in: dinero entró → al borrar lo quitamos del destino
        const revertA =
          existing.type === 'transfer_out' ? Number(existing.amount) : -Number(existing.amount);
        await tx.envelope.update({
          where: { id: existing.envelopeId },
          data: { currentBalance: { increment: revertA } },
        });

        if (pair) {
          const revertB =
            pair.type === 'transfer_out' ? Number(pair.amount) : -Number(pair.amount);
          await tx.envelope.update({
            where: { id: pair.envelopeId },
            data: { currentBalance: { increment: revertB } },
          });
          // Cortar el ciclo de FK antes de borrar
          await tx.transaction.update({
            where: { id: pair.id },
            data: { relatedTransactionId: null },
          });
          await tx.transaction.update({
            where: { id: existing.id },
            data: { relatedTransactionId: null },
          });
          await tx.transaction.delete({ where: { id: pair.id } });
        }
        await tx.transaction.delete({ where: { id: existing.id } });
        return { ok: true, deletedPair: !!pair };
      }

      // Income/expense normal
      const revert =
        existing.type === 'income' ? -Number(existing.amount) : Number(existing.amount);
      await tx.envelope.update({
        where: { id: existing.envelopeId },
        data: { currentBalance: { increment: revert } },
      });
      await tx.transaction.delete({ where: { id } });
      return { ok: true };
    });
  }

  // =========================================================
  //  LIST con filtros + paginación + totales
  // =========================================================
  async list(userId: string, q: ListTransactionsDto) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 50));

    const where: Prisma.TransactionWhereInput = { userId };
    if (q.from || q.to) {
      where.occurredAt = {};
      if (q.from) (where.occurredAt as Prisma.DateTimeFilter).gte = new Date(q.from);
      if (q.to) (where.occurredAt as Prisma.DateTimeFilter).lte = new Date(q.to);
    }
    if (q.envelopeId) where.envelopeId = q.envelopeId;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.type) where.type = q.type;

    const [items, total, agg] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: this.includeRefs(),
      }),
      this.prisma.transaction.count({ where }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where,
        _sum: { amount: true },
      }),
    ]);

    const sumByType = (types: string[]) =>
      agg
        .filter((r) => types.includes(r.type))
        .reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);

    return {
      items: items.map((t) => this.toPublic(t)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      totals: {
        income: sumByType(['income']),
        expense: sumByType(['expense']),
        transferIn: sumByType(['transfer_in']),
        transferOut: sumByType(['transfer_out']),
        net: sumByType(['income']) - sumByType(['expense']),
      },
    };
  }

  // =========================================================
  //  GET BY ID
  // =========================================================
  async getById(userId: string, id: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id, userId },
      include: this.includeRefs(),
    });
    if (!tx) throw new NotFoundException('Movimiento no encontrado.');
    return this.toPublic(tx);
  }

  // =========================================================
  //  HELPERS
  // =========================================================
  private includeRefs() {
    return {
      envelope: { select: { id: true, name: true, icon: true, color: true } },
      category: { select: { id: true, name: true, icon: true, color: true, type: true } },
    } satisfies Prisma.TransactionInclude;
  }

  private toPublic(t: {
    id: string;
    type: string;
    amount: Prisma.Decimal;
    description: string | null;
    occurredAt: Date;
    relatedTransactionId: string | null;
    envelope: { id: string; name: string; icon: string; color: string };
    category: { id: string; name: string; icon: string; color: string; type: string } | null;
    createdAt: Date;
  }) {
    return {
      id: t.id,
      type: t.type as 'income' | 'expense' | 'transfer_in' | 'transfer_out',
      amount: Number(t.amount),
      description: t.description,
      occurredAt: t.occurredAt,
      relatedTransactionId: t.relatedTransactionId,
      envelope: t.envelope,
      category: t.category,
      createdAt: t.createdAt,
    };
  }
}
