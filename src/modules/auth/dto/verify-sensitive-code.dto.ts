import { IsIn, IsString, Length, Matches } from 'class-validator';

export class VerifySensitiveCodeDto {
  @IsString()
  @Length(6, 6, { message: 'El código debe tener exactamente 6 dígitos.' })
  @Matches(/^\d{6}$/, { message: 'El código debe ser numérico.' })
  code: string;

  @IsIn(['change_password', 'change_email'], {
    message: 'Propósito no válido.',
  })
  purpose: 'change_password' | 'change_email';
}
