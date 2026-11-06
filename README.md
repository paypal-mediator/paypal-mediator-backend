# ResolveAI — Backend

Backend NestJS modular. El frontend vive en otro repositorio.
Consulta [information.md](information.md) para el producto y
[docs/architecture.md](docs/architecture.md) para la organización del código.

## Estado real

Base común: HTTP, configuración Zod, Prisma/PostgreSQL, health/readiness,
errores uniformes, Swagger y CI. M01 agrega usuarios Supabase Auth, roles,
políticas del merchant y comprobación de conectividad PayPal Sandbox.
La guía de configuración y el contrato para el frontend están en
[docs/m01-merchants.md](docs/m01-merchants.md).
M01 se verificó con Supabase Auth/PostgreSQL reales y PayPal Sandbox: login,
acceso del administrador, consulta de disputas y persistencia del check.
M02 agrega [webhooks verificados y una outbox persistida](docs/m02-event-ingestion.md),
con deduplicación y comunicación con M01. El primer incremento de
[M03](docs/m03-transactions.md) consume capturas y expone listado/detalle por
merchant con checklist documental. Su worker está activo por defecto en producción;
en desarrollo se activa con `TRANSACTION_WORKER_ENABLED=true`. Un `false` explícito
lo desactiva en cualquier entorno. La ampliación local de M03 agrega órdenes,
vinculación y checklist dinámico mediante una [base estructurada de M04](docs/m04-evidence.md).
Requiere la quinta migración y aún no está desplegada. Archivos/Storage y conectores
de M04, M05–M09 y OpenAI siguen pendientes. Las pruebas automatizadas de
PayPal usan respuestas MOCK explícitas; la verificación real está registrada
en [docs/validation.md](docs/validation.md).

## Arranque

Requiere Node.js 24 LTS, pnpm 10.34.9 y PostgreSQL local o Supabase.
Instalar pnpm con `npm install --global pnpm@10.34.9` o Corepack.
En PowerShell, si la política bloquea scripts, usar `npm.cmd`/`pnpm.cmd`;
también se puede sustituir `pnpm` por `npx.cmd --yes pnpm@10.34.9`.

Desde la raíz:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# Editar DATABASE_URL y DIRECT_URL para el entorno.
pnpm db:generate
pnpm db:deploy
pnpm dev
```

La API y Prisma leen `.env` desde la raíz. Sin `DATABASE_URL` válida la API
no inicia. Con URL válida pero servidor inaccesible, liveness responde y
readiness devuelve 503. Nunca subir credenciales al repositorio.

| Recurso   | URL local                                | Comportamiento                                        |
| --------- | ---------------------------------------- | ----------------------------------------------------- |
| Liveness  | `http://localhost:3001/api/health`       | 200 si el proceso responde; no verifica integraciones |
| Readiness | `http://localhost:3001/api/health/ready` | `SELECT 1`; 200 con DB accesible, 503 si falla        |
| Swagger   | `http://localhost:3001/api/docs`         | Documentación de endpoints implementados              |
| OpenAPI   | `http://localhost:3001/api/openapi.json` | Contrato HTTP JSON                                    |

Swagger se desactiva por defecto en producción; `SWAGGER_ENABLED` permite
configurarlo explícitamente. `CORS_ORIGIN` acepta orígenes exactos separados
por comas y es obligatorio en producción. CORS no sustituye autenticación.
Las rutas de salud y documentación son públicas; las rutas de M01 exigen JWT
de usuario Supabase y una membresía activa provisionada en el servidor.

## Validación y desarrollo

```powershell
pnpm check          # Prisma, lint, formato, tipos, tests y build
pnpm dev            # API en watch; compila contratos al arrancar
pnpm build
pnpm start          # Ejecuta el build
pnpm format
pnpm db:migrate --name nombre_del_cambio
```

Si editas contratos durante `dev`, recompílalos con
`pnpm --filter @resolve-ai/contracts build` y reinicia el proceso.
Los builds y el cliente Prisma generado no se suben a Git.

Las pruebas normales levantan una app Nest real; comprueban también readiness
con DB inaccesible y no necesitan credenciales externas. La suite de DB
requiere una **base de pruebas desechable**, previamente migrada:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/resolve_ai_test'
$env:DIRECT_URL = $env:DATABASE_URL
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm db:deploy
pnpm test:db
```

La escritura de prueba se revierte mediante una transacción. `test:db` falla
si falta `TEST_DATABASE_URL`; no omite la integración silenciosamente.
GitHub Actions usa PostgreSQL 17, ejecuta `check`, aplica migraciones, prueba
DB y comprueba que volver a aplicar las migraciones es seguro.

## Despliegue y equipo

Build: `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm build`.
Release: `pnpm db:deploy`. Arranque: `pnpm start`.
Escucha en `0.0.0.0:$PORT` y cierra el pool al apagarse.
Usar `/api/health/ready` para comprobar disponibilidad de DB.
API publicada en Render: <https://resolve-ai-api-ybmj.onrender.com/api>.
M01, M02 y el primer incremento de M03 están desplegados; ver
[despliegue](docs/deployment.md) y [validación](docs/validation.md).

La base inicial se trabaja en `main`; las siguientes funcionalidades van en
`feat/m01-*` a `feat/m09-*` y se integran por PR. Actualizar cada rama desde
`main` antes de comenzar su módulo. No agregar frontend a este repositorio.

Referencias: [conexiones Prisma 7](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections)
y [Swagger NestJS](https://docs.nestjs.com/openapi/introduction).
