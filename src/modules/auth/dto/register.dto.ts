import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'El correo no tiene un formato válido.' })
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @MaxLength(72, { message: 'La contraseña es demasiado larga.' })
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'La contraseña debe incluir al menos una mayúscula, una minúscula y un número.',
  })
  password!: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 80)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 80)
  lastName!: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 40)
  nickname!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
