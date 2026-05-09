import {
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  nickname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /**
   * Avatar:
   *   · `string` URL → setea avatar
   *   · `null`       → borra avatar (vuelve a iniciales)
   *   · ausente      → no cambia
   *
   * Usamos ValidateIf para que el validador `IsUrl` se SALTE cuando avatarUrl
   * viene como null explícito. Sin esto, `null` rebotaría como "no es URL válida".
   */
  @IsOptional()
  @ValidateIf((o) => o.avatarUrl !== null)
  @IsUrl({}, { message: 'El avatar debe ser una URL válida.' })
  avatarUrl?: string | null;
}
