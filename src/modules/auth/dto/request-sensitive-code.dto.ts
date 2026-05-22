import { IsIn } from 'class-validator';

export class RequestSensitiveCodeDto {
  @IsIn(['change_password', 'change_email'], {
    message: 'Propósito no válido.',
  })
  purpose: 'change_password' | 'change_email';
}
