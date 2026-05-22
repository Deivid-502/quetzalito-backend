# Quetzalito — Backend

NestJS 10 · Prisma · PostgreSQL · JWT · Argon2

## Requisitos

- Node.js 18+
- PostgreSQL 15+ (local o Neon en producción)

## Desarrollo local

```bash
cp envexample .env
# Editar .env con tus valores locales

npm install
npx prisma generate
npx prisma migrate dev   # Primera vez: crea las tablas
npm run start:dev
# → http://localhost:3001/api
```

## Deploy en Render

1. Conectar este repo en [render.com](https://render.com) → **New Web Service**
2. Render detecta `render.yaml` automáticamente
3. Configurar las variables de entorno en el dashboard de Render:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión de Neon (pooled) |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 64` |
| `JWT_REFRESH_SECRET` | `openssl rand -base64 64` |
| `FRONTEND_URL` | URL de Vercel ej. `https://quetzalito.vercel.app` |
| `COOKIE_DOMAIN` | Dominio sin `https://`, ej. `quetzalito.vercel.app` |
| `SMTP_HOST` | Host SMTP de tu proveedor |
| `SMTP_PORT` | Puerto SMTP (generalmente 587) |
| `SMTP_USER` | Usuario SMTP |
| `SMTP_PASS` | Contraseña SMTP |
| `MAIL_FROM` | Ej. `Quetzalito <no-reply@quetzalito.com>` |

4. Primera vez en producción, correr la migración manualmente desde Render Shell:
```bash
npx prisma migrate deploy
```

## Estructura de módulos

```
src/
├── modules/
│   ├── auth/          JWT, registro, login, 2FA, verificación email
│   ├── dashboard/     Datos del dashboard por usuario
│   ├── envelopes/     Sobres/alcancías
│   ├── transactions/  Movimientos financieros
│   ├── categories/    Categorías
│   ├── budgets/       Presupuestos por categoría
│   ├── subscriptions/ Plan free/premium
│   ├── users/         Perfil y ajustes
│   ├── mailer/        Envío de emails
│   └── health/        GET /api/health (Render health check)
├── common/
│   ├── audit/         Registro de eventos de seguridad
│   ├── decorators/    @Public(), @CurrentUser()
│   ├── filters/       HttpExceptionFilter global
│   └── guards/        JwtAuthGuard global
└── database/
    └── prisma/        PrismaService y PrismaModule
```

## Scripts

```bash
npm run start:dev     # Desarrollo con watch
npm run build         # Compilar TypeScript
npm run start:prod    # Producción
npm run lint          # ESLint
npx prisma studio     # GUI de la BD
```
