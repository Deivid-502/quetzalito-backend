import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TransferDto {
  @IsUUID()
  sourceEnvelopeId!: string;

  @IsUUID()
  destinationEnvelopeId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El monto debe tener máximo 2 decimales.' })
  @Min(0.01, { message: 'El monto debe ser mayor a 0.' })
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
