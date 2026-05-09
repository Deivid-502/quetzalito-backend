import {
  IsHexColor,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEnvelopeDto {
  @IsString()
  @Length(1, 50, { message: 'El nombre debe tener entre 1 y 50 caracteres.' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsString()
  @MaxLength(50)
  icon!: string;

  @IsHexColor({ message: 'El color debe estar en formato #RRGGBB.' })
  color!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  targetAmount?: number;

  /**
   * Saldo inicial. Si > 0, se debita de la alcancía principal del usuario
   * (transferencia interna automática). No se permite saldo inicial al crear
   * la cuenta principal (esa la crea el sistema en el registro).
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  initialAmount?: number;
}
