# Organización del backend

```text
apps/api/
  prisma.config.ts           # Prisma CLI y conexión para migraciones
  prisma/
    schema.prisma
    migrations/
  src/
    main.ts                 # Entorno y arranque
    application.ts          # HTTP compartido por runtime y tests
    app.module.ts           # Composición
    common/
      config/               # Schema de entorno y token ENVIRONMENT
      database/             # Cliente Prisma y pool
      http/                 # Errores, request ID y pipe Zod
      core.module.ts        # Proveedores compartidos
    modules/
      health/               # Liveness y readiness
      merchants/            # M01: usuarios, políticas e integración Sandbox
    generated/prisma/       # Generado, ignorado en Git
  test/
    unit/
    http/
    integration/            # PostgreSQL real, suite test:db
packages/contracts/src/     # Schemas Zod y tipos públicos
docs/                       # Guías y decisiones
.github/workflows/          # CI
```

Conservar en la raíz documentación de entrada y configuraciones de workspace,
entorno y herramientas. TypeScript, ESLint, Prettier y Vitest conservan sus
configuraciones convencionales para que comandos y editores las descubran.
No crear carpetas vacías ni stubs que aparenten funcionalidades implementadas.

## Módulos futuros

| ID  | Carpeta en `src/modules` | Responsabilidad                                 |
| --- | ------------------------ | ----------------------------------------------- |
| M01 | `merchants`              | Merchant, integraciones y autorización          |
| M02 | `event-ingestion`        | Firma, persistencia y deduplicación de webhooks |
| M03 | `transactions`           | Pagos, órdenes y preparación documental         |
| M04 | `evidence`               | Originales, procedencia y versiones             |
| M05 | `investigator`           | Investigación con herramientas de lectura       |
| M06 | `verifier`               | Verificación independiente de fuentes           |
| M07 | `disputes`               | Orquestación y estados internos                 |
| M08 | `submissions`            | Guard determinista y envío autorizado           |
| M09 | `monitoring`             | Auditoría persistente y actividad               |

Cada carpeta contendrá su módulo NestJS y su interfaz pública; añadir
subcarpetas según el volumen. Importar servicios exportados por su módulo
propietario y no escribir tablas privadas de otros módulos.
`CoreModule` comparte `PrismaService` y `ENVIRONMENT`.
Los contratos HTTP se exportan desde `@resolve-ai/contracts`; los contratos
de dominio de `information.md` siguen siendo propuestas.

## Decisiones

- Un proceso NestJS, sin frontend ni infraestructura de colas todavía.
- TypeScript estricto, ESM, Node 24 y pnpm con lockfile. NestJS 11 y Prisma 7
  fijados; no utilizar la versión candidata Prisma 8.
- Prisma genera TypeScript en `src/generated/prisma` y usa adaptador PostgreSQL.
  `DATABASE_URL` es conexión de runtime; `DIRECT_URL` es para migraciones y
  puede caer en `DATABASE_URL`. En Supabase usar conexión directa o session
  pooler para migraciones, no transaction pooler.
- M01 es propietario de Merchant, MerchantMember, MerchantIntegration y
  MerchantEvent. Usuarios de Supabase Auth se vinculan por UUID; los roles
  locales se consultan desde PostgreSQL. Ver [M01](m01-merchants.md).
- Pool de cinco conexiones, tiempos de espera configurables, conexión bajo
  demanda. Liveness no afirma conectividad; readiness consulta PostgreSQL.
- Errores `{ code, message, requestId }`. Los errores internos se sanitizan y
  solo se registran código, estado y request ID, sin cuerpos ni secretos.
- `rawBody` disponible para que M02 implemente firma de webhooks. No existe
  todavía ningún endpoint de webhook.
- Helmet, límite de cuerpo de 1 MB y CORS exacto. M01 valida JWT asimétricos de
  Supabase y membresías activas antes de acceder al merchant. Roles ADMIN y
  VIEWER; las políticas exigen aprobación humana.
- Solo `PAYPAL_ENV=sandbox`. M01 puede comprobar OAuth y lectura de disputas
  mediante petición explícita del administrador. OpenAI y Storage siguen
  pendientes. Los tests externos son MOCK identificados.
- Aprobación humana por defecto para futuros envíos. La IA nunca tendrá
  acceso directo a la operación de presentación de evidencia.

## Pendiente

Se fija la dependencia transitiva Multer en 2.5.0 mediante override, porque
NestJS 11.2.8 declara 2.4.0, afectada por
[GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m).
Revisar el override cuando NestJS actualice su dependencia.
ESLint y typescript-eslint usan Minimatch 11.0.1 mediante override por
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).

M02–M09, auditoría append-only, Storage, herramientas de IA,
contratos de dominio, prueba real de disputas Sandbox, despliegue y licencia
acordada por el equipo.
