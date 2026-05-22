import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger('MailerService');
  private transporter: nodemailer.Transporter | null = null;
  private readonly from: string;
  private readonly isDev: boolean;

  constructor(private readonly config: ConfigService) {
    this.isDev = config.get<string>('NODE_ENV') !== 'production';
    this.from = config.get<string>('MAIL_FROM') ?? 'Quetzalito <no-reply@quetzalito.com>';

    const host = config.get<string>('SMTP_HOST');

    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: config.get<number>('SMTP_PORT') ?? 587,
        secure: config.get<boolean>('SMTP_SECURE') ?? false,
        auth: {
          user: config.get<string>('SMTP_USER'),
          pass: config.get<string>('SMTP_PASS'),
        },
      });
    } else {
      this.logger.warn('SMTP_HOST no configurado — emails se imprimirán en consola (modo dev).');
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Enviar verificación de email al registrarse
  // ──────────────────────────────────────────────────────────
  async sendEmailVerification(to: string, code: string, lang: 'es' | 'en' = 'es'): Promise<void> {
    const subject = lang === 'es'
      ? 'Quetzalito — Verificá tu correo'
      : 'Quetzalito — Verify your email';

    const html = lang === 'es'
      ? this.buildVerifyTemplate(code, 'es')
      : this.buildVerifyTemplate(code, 'en');

    await this.send(to, subject, html);
  }

  // ──────────────────────────────────────────────────────────
  //  Enviar código de 2FA para acción sensible
  // ──────────────────────────────────────────────────────────
  async sendSensitiveCode(
    to: string,
    code: string,
    purpose: 'change_password' | 'change_email',
    lang: 'es' | 'en' = 'es',
  ): Promise<void> {
    const subjects: Record<string, Record<string, string>> = {
      change_password: {
        es: 'Quetzalito — Código para cambiar contraseña',
        en: 'Quetzalito — Code to change your password',
      },
      change_email: {
        es: 'Quetzalito — Código para cambiar correo',
        en: 'Quetzalito — Code to change your email',
      },
    };

    const subject = subjects[purpose][lang];
    const html = this.buildSensitiveTemplate(code, purpose, lang);
    await this.send(to, subject, html);
  }

  // ──────────────────────────────────────────────────────────
  //  Envío base
  // ──────────────────────────────────────────────────────────
  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      // Dev: imprimir en consola con formato claro
      this.logger.debug('═══════════════════════════════════════');
      this.logger.debug(`📧 EMAIL → ${to}`);
      this.logger.debug(`   Asunto: ${subject}`);
      this.logger.debug(`   HTML: ${html.replace(/<[^>]+>/g, '').slice(0, 200)}`);
      this.logger.debug('═══════════════════════════════════════');
      return;
    }

    try {
      await this.transporter.sendMail({ from: this.from, to, subject, html });
    } catch (err) {
      this.logger.error(`Error enviando email a ${to}: ${String(err)}`);
      // No lanzamos — el error de envío no debe derribar el flujo del usuario
    }
  }

  // ──────────────────────────────────────────────────────────
  //  Templates HTML mínimos
  // ──────────────────────────────────────────────────────────
  private buildVerifyTemplate(code: string, lang: 'es' | 'en'): string {
    const texts = {
      es: {
        title: 'Verificá tu correo electrónico',
        body: 'Ingresá el siguiente código en Quetzalito para confirmar tu cuenta:',
        expiry: 'Este código expira en 10 minutos.',
        ignore: 'Si no creaste una cuenta, ignorá este mensaje.',
      },
      en: {
        title: 'Verify your email address',
        body: 'Enter the following code in Quetzalito to confirm your account:',
        expiry: 'This code expires in 10 minutes.',
        ignore: 'If you didn\'t create an account, ignore this message.',
      },
    };
    return this.wrapTemplate(code, texts[lang]);
  }

  private buildSensitiveTemplate(
    code: string,
    purpose: string,
    lang: 'es' | 'en',
  ): string {
    const texts = {
      es: {
        title: purpose === 'change_password' ? 'Cambio de contraseña' : 'Cambio de correo',
        body: 'Ingresá este código en Quetzalito para confirmar la acción:',
        expiry: 'Este código expira en 10 minutos. Si no solicitaste este cambio, ignorá el mensaje.',
        ignore: 'Si no fuiste vos, cambiá tu contraseña inmediatamente.',
      },
      en: {
        title: purpose === 'change_password' ? 'Password change' : 'Email change',
        body: 'Enter this code in Quetzalito to confirm the action:',
        expiry: 'This code expires in 10 minutes. If you didn\'t request this change, ignore this message.',
        ignore: 'If this wasn\'t you, change your password immediately.',
      },
    };
    return this.wrapTemplate(code, texts[lang]);
  }

  private wrapTemplate(
    code: string,
    texts: { title: string; body: string; expiry: string; ignore: string },
  ): string {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${texts.title}</title></head>
<body style="font-family:sans-serif;background:#f9fafb;padding:40px 0;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;">
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-size:32px;">💰</span>
      <h1 style="color:#1a1a1a;font-size:22px;margin:12px 0 0;">Quetzalito</h1>
    </div>
    <h2 style="color:#111827;font-size:18px;margin:0 0 12px;">${texts.title}</h2>
    <p style="color:#4b5563;font-size:15px;margin:0 0 24px;">${texts.body}</p>
    <div style="text-align:center;margin:32px 0;">
      <div style="display:inline-block;background:#10b981;color:#fff;font-size:36px;font-weight:700;letter-spacing:12px;padding:16px 32px;border-radius:12px;">
        ${code}
      </div>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0 0 8px;">${texts.expiry}</p>
    <p style="color:#9ca3af;font-size:12px;margin:0;">${texts.ignore}</p>
  </div>
</body>
</html>`;
  }
}
