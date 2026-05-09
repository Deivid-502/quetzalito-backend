import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista categorías del sistema + las propias del usuario.
   * Filtrable por tipo: 'income' | 'expense'.
   */
  async list(userId: string, type?: 'income' | 'expense') {
    const where: Prisma.CategoryWhereInput = {
      OR: [{ isSystem: true }, { userId }],
    };
    if (type) {
      where.type = { in: [type, 'both'] };
    }

    const categories = await this.prisma.category.findMany({
      where,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    return categories.map(this.toPublic);
  }

  async create(userId: string, dto: CreateCategoryDto) {
    // Nombre único entre las del usuario (las del sistema sí pueden duplicarse)
    const dup = await this.prisma.category.findFirst({
      where: {
        userId,
        name: { equals: dto.name.trim(), mode: 'insensitive' },
      },
    });
    if (dup) throw new ConflictException('Ya tenés una categoría con ese nombre.');

    const created = await this.prisma.category.create({
      data: {
        userId,
        name: dto.name.trim(),
        icon: dto.icon,
        color: dto.color,
        type: dto.type,
        isSystem: false,
      },
    });
    return this.toPublic(created);
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Categoría no encontrada.');
    if (existing.isSystem) {
      throw new ForbiddenException('No podés modificar una categoría del sistema.');
    }
    if (existing.userId !== userId) throw new NotFoundException('Categoría no encontrada.');

    if (dto.name && dto.name.trim() !== existing.name) {
      const dup = await this.prisma.category.findFirst({
        where: {
          userId,
          id: { not: id },
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
      if (dup) throw new ConflictException('Ya tenés una categoría con ese nombre.');
    }

    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        icon: dto.icon,
        color: dto.color,
        type: dto.type,
      },
    });
    return this.toPublic(updated);
  }

  async remove(userId: string, id: string, reassignToCategoryId?: string) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Categoría no encontrada.');
    if (existing.isSystem) {
      throw new ForbiddenException('No podés eliminar una categoría del sistema.');
    }
    if (existing.userId !== userId) throw new NotFoundException('Categoría no encontrada.');

    const txCount = await this.prisma.transaction.count({
      where: { categoryId: id },
    });

    // Caso simple: sin movimientos asociados → borra directo (limpia presupuestos huérfanos)
    if (txCount === 0) {
      await this.prisma.$transaction([
        this.prisma.budget.deleteMany({ where: { categoryId: id, userId } }),
        this.prisma.category.delete({ where: { id } }),
      ]);
      return { ok: true, reassigned: 0 };
    }

    // Hay movimientos: requiere reasignación
    if (!reassignToCategoryId) {
      throw new BadRequestException(
        `Esta categoría tiene ${txCount} movimientos. Indicá una categoría de reemplazo para reasignarlos.`,
      );
    }

    if (reassignToCategoryId === id) {
      throw new BadRequestException('La categoría de reemplazo debe ser distinta.');
    }

    const target = await this.prisma.category.findFirst({
      where: {
        id: reassignToCategoryId,
        OR: [{ isSystem: true }, { userId }],
      },
    });
    if (!target) throw new NotFoundException('Categoría de reemplazo no encontrada.');
    // Validar compatibilidad de tipos
    if (target.type !== 'both' && target.type !== existing.type && existing.type !== 'both') {
      throw new BadRequestException(
        'La categoría de reemplazo no es compatible con el tipo de la categoría a eliminar.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.transaction.updateMany({
        where: { categoryId: id, userId },
        data: { categoryId: reassignToCategoryId },
      }),
      this.prisma.budget.deleteMany({ where: { categoryId: id, userId } }),
      this.prisma.category.delete({ where: { id } }),
    ]);

    return { ok: true, reassigned: txCount };
  }

  private toPublic(c: {
    id: string;
    name: string;
    icon: string;
    color: string;
    type: string;
    isSystem: boolean;
    userId: string | null;
  }) {
    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      type: c.type as 'income' | 'expense' | 'both',
      isSystem: c.isSystem,
    };
  }
}
