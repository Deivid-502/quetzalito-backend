import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como público (sin requerir JWT).
 * Por defecto TODA ruta del API es privada (JwtAuthGuard global).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
