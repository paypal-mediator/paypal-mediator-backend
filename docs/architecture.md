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
      event-ingestion/      # M02: firma, persistencia y outbox de webhooks
      transactions/         # M03: capturas, consultas y checklist documental
      evidence/             # M04: registros, archivos privados, versiones y cobertura
      investigator/         # M05: prompts, proveedores y borradores citados (incremento local)
      verifier/             # M06: revisión independiente de fuentes
      monitoring/           # M09: auditoría transaccional, timeline y métricas
      disputes/             # M07: ingesta, vinculación y estado interno de disputas
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

M09 instrumenta M01–M06. `AuditModule` publica escritura append-only
transaccional sin importar módulos de negocio. `MonitoringModule` importa sus
interfaces públicas para consultar estados operativos; expone `/api/activity`
y `/api/activity/metrics`. Los productores importan únicamente el módulo/servicio
de escritura para evitar dependencias circulares. Ver [alcance M09](m09-monitoring.md).

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
- M02 utiliza `rawBody` en `/api/webhooks/paypal`, conserva los bytes y verifica
  la entrega con la API oficial de PayPal antes de persistir y encolar.
- Helmet, límite de cuerpo de 1 MB y CORS exacto. M01 valida JWT asimétricos de
  Supabase y membresías activas antes de acceder al merchant. Roles ADMIN y
  VIEWER; las políticas exigen aprobación humana.
- Solo `PAYPAL_ENV=sandbox`. M01 puede comprobar OAuth y lectura de disputas
  mediante petición explícita del administrador. OpenAI sigue pendiente. M04
  conserva archivos originales en Storage privado, verificado con una foto del
  usuario y servicios Supabase reales; los tests automatizados usan MOCK explícito.
- Aprobación humana por defecto para futuros envíos. La IA nunca tendrá
  acceso directo a la operación de presentación de evidencia.

## Pendiente

Se fija la dependencia transitiva Multer en 2.5.0 mediante override, porque
NestJS 11.2.8 declara 2.4.0, afectada por
[GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m).
Revisar el override cuando NestJS actualice su dependencia.
ESLint y typescript-eslint usan Minimatch 11.0.1 mediante override por
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).

Completar conectores M04, M05–M06 y M08–M09, auditoría append-only, herramientas
de IA, contratos de dominio, presentación real de evidencia, prueba real de
disputas Sandbox y licencia acordada por el equipo.

M05 cuenta con un primer incremento local de investigación preventiva solicitada
por ADMIN, con proveedor NVIDIA/OpenAI intercambiable, prompts versionados y
tabla propia `investigation_runs`. Consume la interfaz pública de M03/M04 y
políticas de M01; no escribe evidencia ni presenta a PayPal. NVIDIA se verificó
con servicios reales; OpenAI solo con MOCK. Ver [M05](m05-investigator.md).

El backend está publicado en Render; ver [despliegue](deployment.md) para la URL,
configuración y límites de la validación externa.

M02 recibe webhooks mediante M01 (contexto del merchant y OAuth público de
módulo), verifica firmas con PayPal y guarda eventos/trabajos de forma atómica.
M03 consume capturas mediante la interfaz pública `IngestionQueueService` de M02,
que controla los locks y la transacción compartida; cada consumidor escribe solo
sus tablas. El worker de M03 se activa por configuración. M07 consume
`DISPUTE_CHANGED` con la misma interfaz, mantiene estados PayPal y locales
separados y solo vincula capturas de M03 por `seller_transaction_id`; no presenta
evidencia. Ver [M03](m03-transactions.md) y [M07](m07-disputes.md).
Ver [M02](m02-event-ingestion.md) para contratos y límites de la verificación.

La ampliación de M03 agrega órdenes comerciales y utiliza el contrato público
de M04 (`EvidenceService`) para expedientes JSON versionados y readiness dinámico.
La unidad de trabajo Prisma se comparte por parámetro; cada servicio escribe solo
sus tablas. M04 recibe contexto autorizado de M03 y no importa su módulo. Los GET
leen snapshots; POST de pedido/evidencia/refresh reconcilian y persisten. Ver
[contrato M04](m04-evidence.md) y los límites de una captura/un paquete por pedido.

## Integraci?n local M05/M06 pendiente de pruebas

M06 (`verifier`) consume la interfaz p?blica M05 y recupera originales de M03/M04
con contexto independiente. Es propietario de VerificationRun; no escribe resultados
en InvestigationRun. Comparte solo el transporte AI exportado por InvestigatorModule.
Ver [contrato y l?mites M06](m06-verifier.md). Este incremento no est? validado con
pruebas ni aplicado a PostgreSQL; no implica implementaci?n de M07/M08.
