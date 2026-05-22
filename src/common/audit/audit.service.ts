import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma/prisma.service';

export type AuditAction =
  | 'AUTH_REGISTER'
  | 'AUTH_LOGIN'
  | 'AUTH_LOGIN_FAIL'
  | 'AUTH_LOGOUT'
  | 'AUTH_REFRESH'
  | 'AUTH_REFRESH_FAIL'
  | 'EMAIL_VERIFY_SEND'
  | 'EMAIL_VERIFY_CONFIRM'
  | 'EMAIL_VERIFY_FAIL'
  | 'SENSITIVE_CODE_REQUEST'
  | 'SENSITIVE_CODE_VERIFY'
  | 'SENSITIVE_CODE_FAIL'
  | 'PASSWORD_CHANGED'
  | 'EMAIL_CHANGED'
  | 'PROFILE_UPDATED'
  | 'ACCOUNT_DELETED'
  | 'SUBSCRIPTION_ACTIVATED'
  | 'SUBSCRIPTION_CANCELLED'
  | 'ENVELOPE_CREATED'
  | 'ENVELOPE_ARCHIVED';

export type AuditStatus = 'ok' | 'fail';

export interface AuditEntry {
  userId?: string;
  action: AuditAction;
  status: AuditStatus;
  ipAddress?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditService');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra un evento en audit_logs.
   * Nunca lanza excepción — un fallo de auditoría no debe romper el flujo del usuario.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          status: entry.status,
          ipAddress: this.maskIp(entry.ipAddress),
          userAgent: entry.userAgent?.slice(0, 512) ?? null,
          meta: entry.meta ?? undefined,
        },
      });
    } catch (err) {
      // Log interno pero no propagamos el error al caller
      this.logger.error(`Error guardando audit log [${entry.action}]: ${String(err)}`);
    }
  }

  /**
   * Enmascara el último octeto de IPv4 y los últimos 64 bits de IPv6
   * para cumplir con principios de minimización de datos (GDPR-style).
   */
  private maskIp(ip?: string): string | null {
    if (!ip) return null;
    // IPv4: 192.168.1.XXX
    if (ip.includes('.')) {
      const parts = ip.split('.');
      if (parts.length === 4) {
        parts[3] = 'xxx';
        return parts.join('.');
      }
    }
    // IPv6: enmascara los últimos 4 grupos
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return [...parts.slice(0, 4), 'xxxx', 'xxxx', 'xxxx', 'xxxx'].join(':');
    }
    return ip;
  }
}
