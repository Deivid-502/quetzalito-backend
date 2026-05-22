import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const logger = new Logger('Bootstrap');
  const port = process.env.PORT ?? 3001;
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
  const isProd = process.env.NODE_ENV === 'production';

  // ===== Helmet con CSP configurado =====
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", frontendUrl],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,  // Necesario para algunos assets
      hsts: isProd
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(cookieParser());

  // ===== CORS estricto al frontend =====
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: [],
    maxAge: 600, // pre-flight cache 10 min
  });

  // ===== Validación global — whitelist estricto =====
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // Elimina campos no declarados en el DTO
      forbidNonWhitelisted: true, // 400 si llegan campos extra
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,    // Devuelve todos los errores juntos
    }),
  );

  // ===== Filtro global de errores =====
  app.useGlobalFilters(new HttpExceptionFilter());

  // ===== Prefijo global =====
  app.setGlobalPrefix('api');

  // ===== Deshabilitar X-Powered-By (helmet lo hace pero explicitamos) =====
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  await app.listen(port);
  logger.log(`Quetzalito API → http://localhost:${port}/api [${isProd ? 'prod' : 'dev'}]`);
}

bootstrap();
