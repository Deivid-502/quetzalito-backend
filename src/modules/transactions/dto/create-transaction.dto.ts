import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateTransactionDto {
  /**
   * Tipo: 'income' o 'expense'.
   * Las transferencias internas (transfer_in / transfer_out) NO se crean por aquí,
   * se crean a través de POST /envelopes/transfer.
   */
  @IsIn(['income', 'expense'])
  type!: 'income' | 'expense';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El monto debe tener máximo 2 decimales.' })
  @Min(0.01, { message: 'El monto debe ser mayor a 0.' })
  amount!: number;

  @IsUUID()
  envelopeId!: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  /** Si no se envía, se usa NOW() */
  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}
