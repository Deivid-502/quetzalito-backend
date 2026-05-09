import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CreateEnvelopeDto } from './dto/create-envelope.dto';
import { UpdateEnvelopeDto } from './dto/update-envelope.dto';
import { TransferDto } from './dto/transfer.dto';

const FREE_TIER_ENVELOPE_LIMIT = 5;

@Injectable()
export class EnvelopesService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================
  //  LIST
  // =========================================================
  async list(userId: string, includeArchived = false) {
    const where: Prisma.EnvelopeWhereInput = { userId };
    if (!includeArchived) where.archivedAt = null;

    const envelopes = await this.prisma.envelope.findMany({
      where,
      orderBy: [{ isMain: 'desc' }, { createdAt: 'asc' }],
    });

    // Suma global = suma de saldos no archivados (la cuenta principal NO se duplica
    // porque las transferencias mueven dinero entre sobres, nunca lo crean)
    const totalBalance = envelopes
      .filter((e) => !e.archivedAt)
      .reduce((sum, e) => sum + Number(e.currentBalance), 0);

    return {
      envelopes: envelopes.map(this.toPublic),
      totalBalance,
    };
  }

  // =========================================================
  //  GET BY ID
  // =========================================================
  async getById(userId: string, id: string) {
    const envelope = await this.prisma.envelope.findFirst({
      where: { id, userId },
    });
    if (!envelope) throw new NotFoundException('Sobre no encontrado.');

    // Estadísticas básicas del sobre
    const [recentTx, monthAgg] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { envelopeId: id, userId },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        include: {
          category: { select: { id: true, name: true, icon: true, color: true } },
        },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: {
          envelopeId: id,
          userId,
          occurredAt: { gte: this.startOfMonth() },
        },
        _sum: { amount: true },
      }),
    ]);

    const monthIncome = this.sumByType(monthAgg, ['income', 'transfer_in']);
    const monthExpense = this.sumByType(monthAgg, ['expense', 'transfer_out']);

    return {
      envelope: this.toPublic(envelope),
      stats: {
        monthIncome,
        monthExpense,
        progress: envelope.targetAmount
          ? Math.min(100, (Number(envelope.currentBalance) / Number(envelope.targetAmount)) * 100)
          : null,
      },
      recentTransactions: recentTx.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        description: t.description,
        occurredAt: t.occurredAt,
        category: t.category,
      })),
    };
  }

  // =========================================================
  //  CREATE
  // =========================================================
  async create(userId: string, dto: CreateEnvelopeDto) {
    // 1. Plan Free → máximo 5 sobres activos
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { isPremium: true },
    });

    if (!user.isPremium) {
      const count = await this.prisma.envelope.count({
        where: { userId, archivedAt: null },
      });
      if (count >= FREE_TIER_ENVELOPE_LIMIT) {
        throw new ForbiddenException(
          `El plan Free permite hasta ${FREE_TIER_ENVELOPE_LIMIT} sobres. Hazte Premium para crear más.`,
        );
      }
    }

    // 2. Nombre único por usuario (case-insensitive)
    const existing = await this.prisma.envelope.findFirst({
      where: {
        userId,
        archivedAt: null,
        name: { equals: dto.name.trim(), mode: 'insensitive' },
      },
    });
    if (existing) {
      throw new ConflictException('Ya tenés un sobre con ese nombre.');
    }

    // 3. Si initialAmount > 0, se debita de la cuenta principal
    const initial = dto.initialAmount ?? 0;

    return this.prisma.$transaction(async (tx) => {
      // Crear el sobre con balance 0 inicialmente
      const envelope = await tx.envelope.create({
        data: {
          userId,
          name: dto.name.trim(),
          description: dto.description,
          icon: dto.icon,
          color: dto.color,
          targetAmount: dto.targetAmount,
          currentBalance: 0,
          isMain: false,
        },
      });

      // Si pidió saldo inicial, hacemos una transferencia desde la principal
      if (initial > 0) {
        const main = await tx.envelope.findFirst({
          where: { userId, isMain: true, archivedAt: null },
        });
        if (!main) throw new BadRequestException('No se encontró tu cuenta principal.');
        if (Number(main.currentBalance) < initial) {
          throw new BadRequestException(
            'No tenés suficiente saldo en la cuenta principal para iniciar este sobre.',
          );
        }
        await this.executeTransferInTx(tx, userId, main.id, envelope.id, initial,
          `Saldo inicial: ${envelope.name}`);
      }

      // Recargamos para devolver balance final
      const fresh = await tx.envelope.findUniqueOrThrow({ where: { id: envelope.id } });
      return this.toPublic(fresh);
    });
  }

  // =========================================================
  //  UPDATE
  // =========================================================
  async update(userId: string, id: string, dto: UpdateEnvelopeDto) {
    const existing = await this.prisma.envelope.findFirst({
      where: { id, userId },
    });
    if (!existing) throw new NotFoundException('Sobre no encontrado.');
    if (existing.archivedAt) {
      throw new BadRequestException('No podés editar un sobre archivado.');
    }

    if (dto.name && dto.name.trim() !== existing.name) {
      const dup = await this.prisma.envelope.findFirst({
        where: {
          userId,
          archivedAt: null,
          id: { not: id },
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
      if (dup) throw new ConflictException('Ya tenés un sobre con ese nombre.');
    }

    const updated = await this.prisma.envelope.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description,
        icon: dto.icon,
        color: dto.color,
        // null borra la meta, undefined la deja igual
        targetAmount: dto.targetAmount === null ? null : dto.targetAmount,
      },
    });

    return this.toPublic(updated);
  }

  // =========================================================
  //  ARCHIVE  (soft delete)
  //  Si tiene saldo, se mueve automáticamente a la principal.
  // =========================================================
  async archive(userId: string, id: string) {
    const envelope = await this.prisma.envelope.findFirst({
      where: { id, userId },
    });
    if (!envelope) throw new NotFoundException('Sobre no encontrado.');
    if (envelope.isMain) {
      throw new BadRequestException('La cuenta principal no se puede archivar.');
    }
    if (envelope.archivedAt) {
      throw new BadRequestException('Este sobre ya está archivado.');
    }

    return this.prisma.$transaction(async (tx) => {
      const balance = Number(envelope.currentBalance);
      if (balance > 0) {
        const main = await tx.envelope.findFirst({
          where: { userId, isMain: true, archivedAt: null },
        });
        if (!main) throw new BadRequestException('No se encontró tu cuenta principal.');
        await this.executeTransferInTx(
          tx, userId, envelope.id, main.id, balance,
          `Devolución por archivado: ${envelope.name}`,
        );
      }
      const archived = await tx.envelope.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      return this.toPublic(archived);
    });
  }

  // =========================================================
  //  DELETE  (hard, sólo si no tiene transacciones)
  // =========================================================
  async remove(userId: string, id: string) {
    const envelope = await this.prisma.envelope.findFirst({
      where: { id, userId },
    });
    if (!envelope) throw new NotFoundException('Sobre no encontrado.');
    if (envelope.isMain) {
      throw new BadRequestException('La cuenta principal no se puede eliminar.');
    }

    const txCount = await this.prisma.transaction.count({
      where: { envelopeId: id },
    });
    if (txCount > 0) {
      throw new BadRequestException(
        'Este sobre tiene movimientos. Archivalo en lugar de eliminarlo para conservar tu historial.',
      );
    }
    if (Number(envelope.currentBalance) !== 0) {
      throw new BadRequestException('Vacía el sobre antes de eliminarlo.');
    }

    await this.prisma.envelope.delete({ where: { id } });
    return { ok: true };
  }

  // =========================================================
  //  TRANSFER  (entre sobres del mismo usuario, atómico)
  // =========================================================
  async transfer(userId: string, dto: TransferDto) {
    if (dto.sourceEnvelopeId === dto.destinationEnvelopeId) {
      throw new BadRequestException('Origen y destino no pueden ser el mismo sobre.');
    }

    return this.prisma.$transaction(async (tx) => {
      const [source, destination] = await Promise.all([
        tx.envelope.findFirst({
          where: { id: dto.sourceEnvelopeId, userId, archivedAt: null },
        }),
        tx.envelope.findFirst({
          where: { id: dto.destinationEnvelopeId, userId, archivedAt: null },
        }),
      ]);

      if (!source || !destination) {
        throw new NotFoundException('Sobre origen o destino no encontrado.');
      }

      if (Number(source.currentBalance) < dto.amount) {
        throw new BadRequestException('No hay suficiente saldo en el sobre de origen.');
      }

      const result = await this.executeTransferInTx(
        tx, userId, source.id, destination.id, dto.amount, dto.description,
      );

      const [freshSource, freshDest] = await Promise.all([
        tx.envelope.findUniqueOrThrow({ where: { id: source.id } }),
        tx.envelope.findUniqueOrThrow({ where: { id: destination.id } }),
      ]);

      return {
        source: this.toPublic(freshSource),
        destination: this.toPublic(freshDest),
        transferOutId: result.transferOutId,
        transferInId: result.transferInId,
      };
    });
  }

  // =========================================================
  //  HELPERS
  // =========================================================
  /**
   * Ejecuta la transferencia ATÓMICA dentro de una transacción Prisma:
   *   1. Decrementa balance del origen — sólo si sigue activo
   *   2. Incrementa balance del destino — sólo si sigue activo
   *   3. Crea el par de transactions con related_transaction_id bidireccional
   * El llamador es responsable de validar permisos y saldo previo.
   *
   * Usa updateMany con WHERE archivedAt:null para detectar concurrencia: si otro
   * proceso archivó el sobre entre la validación y este update, count será 0
   * y abortamos toda la transacción.
   */
  private async executeTransferInTx(
    tx: Prisma.TransactionClient,
    userId: string,
    sourceId: string,
    destinationId: string,
    amount: number,
    description?: string,
  ): Promise<{ transferOutId: string; transferInId: string }> {
    const decResult = await tx.envelope.updateMany({
      where: { id: sourceId, userId, archivedAt: null },
      data: { currentBalance: { decrement: amount } },
    });
    if (decResult.count !== 1) {
      throw new BadRequestException('El sobre origen ya no está disponible.');
    }

    const incResult = await tx.envelope.updateMany({
      where: { id: destinationId, userId, archivedAt: null },
      data: { currentBalance: { increment: amount } },
    });
    if (incResult.count !== 1) {
      throw new BadRequestException('El sobre destino ya no está disponible.');
    }

    const transferOut = await tx.transaction.create({
      data: {
        userId,
        envelopeId: sourceId,
        type: 'transfer_out',
        amount,
        description,
      },
    });

    const transferIn = await tx.transaction.create({
      data: {
        userId,
        envelopeId: destinationId,
        type: 'transfer_in',
        amount,
        description,
        relatedTransactionId: transferOut.id,
      },
    });

    // Vinculación bidireccional
    await tx.transaction.update({
      where: { id: transferOut.id },
      data: { relatedTransactionId: transferIn.id },
    });

    return { transferOutId: transferOut.id, transferInId: transferIn.id };
  }

  private startOfMonth(): Date {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  private sumByType(
    rows: { type: string; _sum: { amount: Prisma.Decimal | null } }[],
    types: string[],
  ): number {
    return rows
      .filter((r) => types.includes(r.type))
      .reduce((s, r) => s + Number(r._sum.amount ?? 0), 0);
  }

  private toPublic(e: {
    id: string;
    name: string;
    description: string | null;
    icon: string;
    color: string;
    isMain: boolean;
    targetAmount: Prisma.Decimal | null;
    currentBalance: Prisma.Decimal;
    archivedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      icon: e.icon,
      color: e.color,
      isMain: e.isMain,
      targetAmount: e.targetAmount ? Number(e.targetAmount) : null,
      currentBalance: Number(e.currentBalance),
      archivedAt: e.archivedAt,
      createdAt: e.createdAt,
    };
  }
}
