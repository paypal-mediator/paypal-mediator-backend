> **M09 desplegado y verificado (2026-11-07):** PR #16, commit `65bd498`, CI con
> 191 pruebas unitarias/HTTP y 95 PostgreSQL. Timeline/métricas autenticados 200.
> Nuevo pago de 1 USD ficticio aprobado en Opera GX/CDP 9223; webhook genuino,
> fuentes PayPal y Storage íntegros. M05 real COMPLETED; M06 real REJECTED por
> faltantes y una afirmación sin respaldo. Casos DEMO READY/NEEDS_REVIEW y errores
> posteriores M05 conservados. Permisos restaurados; M07 pendiente, M08 implementado y desplegado (Submission Guard).
> Ver [validación y límites M09](docs/m09-monitoring.md#validación-publicada--2026-11-07).

> **M05/M06 verificados localmente (2026-11-07):** pago nuevo PayPal Sandbox de
> 1 USD ficticio, webhook genuino, pedido enriquecido y originales íntegros.
> Investigator y Verifier ejecutados con NVIDIA real: M05 COMPLETED y M06
> INCOMPLETE por falta de tracking/entrega; sin autorización de envío.
> Migración M06 aplicada en Supabase; 189 pruebas unitarias/HTTP y 88 PostgreSQL
> aprobadas. M05/M06 están desplegados en Render con NVIDIA configurado: GET 200
> y POST idempotentes 201, sin otra inferencia. Los permisos quedaron restaurados.
> Aprobación del checkout
> realizada por el usuario porque el control de Opera GX no estaba disponible.
> Ver [evidencia y límites](docs/evidence/m01-m06-sandbox-20261107.json).

> **M09 — implementado para M01–M06:** auditoría transaccional append-only,
> timeline autenticado `/api/activity` con filtros y `/api/activity/metrics`,
> pasos/resultados/errores de agentes, duraciones, tokens y estados de trabajos.
> M07 sigue pendiente. M08 implementado y desplegado: Submission Guard y
> endpoint `/api/disputes/:id/submit` que llama a PayPal `provide-evidence`
> solo cuando el guard lo aprueba. El despliegue y la prueba live se documentan
> por separado; la implementación no implica aprobación o envío a PayPal.
> Ver [alcance y límites](docs/m09-monitoring.md).

# ResolveAI — Contexto de proyecto para Codex CLI

## Incremento M03/M04: fuentes de pedidos

La consulta automática de Orders v2 y la interfaz extensible para fuentes ERP
están implementadas. Prueba real nueva: orden Sandbox `5AA87137A4512751T`, captura
`9L5781332K437132K` por 1 USD ficticio, aprobada en Opera GX. M02 remoto verificó
el evento; el worker nuevo local recuperó dos artículos, cantidades/SKU/importes
exactos, sin pedido manual. M04 guardó original y normalización con integridad
válida; refresh sin duplicados. Faltan envío/entrega, por lo que readiness sigue
`INCOMPLETE`. ERP aún no conectado; segundo adaptador probado con MOCK.
Validación: `pnpm check` (168 pruebas unitarias/HTTP), `pnpm test:db` (72),
migración aplicada/repetida en PostgreSQL de pruebas, sin diferencia de schema,
y aplicada en Supabase. Ver [fuentes](docs/order-information-sources.md) y
[evidencia real](docs/evidence/order-sources-sandbox-20261106.json).

Integrado por PR #15 en `main` (`728eb59`), CI aprobado y publicado en Render.
Worker restaurado y proceso local detenido. Lectura/refresh/backfill reales
desde Render verificados; descarga del archivo previo del usuario desde Storage
con bytes idénticos. Issue #10 cerrado. Ver [validación publicada](docs/validation.md).

> **Estado del documento:** contexto de producto, estado verificado del backend y especificación de los módulos pendientes. Los flujos futuros descritos abajo no implican que todo el MVP esté implementado.
> **Versión:** 1.1 · **Actualizado:** 2026-11-06 · **Deadline del hackathon:** 2026-11-12, 14:00 CST (según la información proporcionada por el equipo).
> **Alcance del repositorio:** únicamente backend. El frontend/M10 se desarrolla en otro repositorio.
> **Objetivo de uso:** leer este documento y `AGENTS.md` al comenzar una sesión; contrastar las propuestas con el código y las pruebas existentes.

## Estado real al 6 de noviembre de 2026

### M05 — primer incremento local con NVIDIA Nemotron y adaptador OpenAI

Se implementó investigación preventiva INR solicitada por ADMIN: prompts
versionados, lectura de M03/M04, inspección de originales PNG/JPEG y borradores
con citas. Octava migración para `investigation_runs`, idempotencia, RLS, límites
de pasos/tiempo, hashes y detección de resultados obsoletos. El proveedor inicial
es `nvidia/nemotron-3.5-super-vl-120b-a12b`; se puede cambiar a OpenAI Responses
mediante configuración. La prueba local con NVIDIA y Supabase reales terminó
en seis pasos y reconoció la foto de apuntes como irrelevante. OpenAI solo tiene
pruebas MOCK, sin credenciales reales. No se desplegó M05 en Render.

No hay fuente comercial conectada, extracción de PDF, Verifier M06 ni presentación
M08. El resultado es un borrador que requiere verificación: se observaron errores
semánticos del modelo aun con schema/citas válidos. Ver [M05](docs/m05-investigator.md)
y [salida original de NVIDIA](docs/evidence/m05-nvidia-live-20261106.json).

### M04 — archivos originales privados, desplegados y verificados

Se implementó carga ADMIN y descarga ADMIN/VIEWER de PDF/PNG/JPEG (hasta 512 KiB),
procedencia explícita, versiones y hashes de originales en Supabase Storage
privado. La sexta migración habilita `DOCUMENT` sin permitir origen PayPal.
Los adjuntos no completan automáticamente tracking/entrega. Además de las pruebas
automatizadas con Storage MOCK, una foto existente del usuario se cargó y descargó
por NestJS local y por Render con Supabase Storage/PostgreSQL reales y hashes idénticos.
Se configuró un bucket privado y se aplicaron las migraciones sexta y séptima.
PR #11 integrado en `main` (`f49fd6c`) y desplegado en Render. Validación de código:
148 pruebas unitarias/HTTP y 64 pruebas PostgreSQL aprobadas. Carga duplicada
HTTP 201, descarga HTTP 200 y acceso sin sesión HTTP 401; archivo idéntico al
original. Los conectores comerciales y agentes siguen pendientes.
Ver [M04](docs/m04-evidence.md) y [validación](docs/validation.md).

### Ampliación M03 — órdenes y coordinación M04, integrada y desplegada

En `feat/m03-transaction-manager` se implementaron órdenes comerciales con artículos,
importes exactos, origen y vinculación antes/después de la captura. La base M04
persiste expedientes JSON con hash e historial; el checklist cambia entre
`INCOMPLETE`, `READY` y `NEEDS_REVIEW` según documentos, retractaciones y conflictos.
Los datos DEMO se etiquetan explícitamente. `READY` es cobertura documental.

Validación local: `pnpm check` con 124 pruebas y `pnpm test:db` con 63 pruebas en
PostgreSQL desechable; quinta migración aplicada, repetida y sin diferencias de
schema. Integrada por PR #8 (`5dfae91`) y desplegada en Render con la quinta
migración aplicada en Supabase.
En esa entrega quedaron pendientes archivos/Storage (resueltos en el incremento
M04 descrito arriba), conectores comerciales y M05–M09.
Ver [M03](docs/m03-transactions.md) y [base M04](docs/m04-evidence.md).
Prueba nueva en Render: orden `1BY117808X500542F`, captura `2D098449XH6131418`
por 1 USD ficticio, webhook genuino y trabajo `COMPLETED`. M03 vinculó el pedido
DEMO y M04 conservó ocho versiones. Se verificaron `READY`, bloqueo por tracking
contradictorio, retractación y restauración; listado/detalle HTTP 200, sin sesión 401.
Pedido, tracking y entrega fueron DEMO; autenticación, PayPal y PostgreSQL reales.
Ver [prueba completa](docs/validation.md). El apartado siguiente conserva el
historial del primer incremento.

### Historial M03 — Primer incremento integrado y desplegado

En `feat/m03-transaction-manager` se implementó el primer incremento de M03:
consumo idempotente de capturas verificadas, persistencia, listado/detalle
autorizados y checklist documental. Validación local: `pnpm check` (109 pruebas)
y `pnpm test:db` (43 pruebas), con migraciones en PostgreSQL desechable.
Integrado en `main` por PR #6 (`ff12287`) y desplegado en Render el 6 de noviembre.
La validación posterior para despliegue pasó `pnpm check` con 111 pruebas y CI con
las 43 pruebas PostgreSQL. En esa fase quedaban pendientes órdenes comerciales
y coordinación con M04; se resolvieron en la ampliación descrita arriba.
Ver [M03](docs/m03-transactions.md).
Posteriormente se aplicó la migración de M03 en Supabase y el worker local
consumió dos capturas genuinas pendientes; listado autenticado real: HTTP 200.
También se capturó la nueva orden Sandbox `8E96636933870233U` por 1 USD ficticio
(captura `7HV195624A539251X`, HTTP 201): webhook genuino recibido por M02 en
Render, trabajo `COMPLETED` y una transacción M03 persistida. Listado y detalle
locales con JWT real: HTTP 200; acceso sin sesión: HTTP 401.
Ver [validación](docs/validation.md).
Render ya expone M03: readiness, listado y detalle HTTP 200; sin sesión HTTP 401.
El worker local temporal se detuvo; el consumidor se habilita por defecto en
producción, respetando `TRANSACTION_WORKER_ENABLED=false` cuando sea explícito.

### Implementado e integrado en `main`

- **Base común:** workspace pnpm, Node 24, TypeScript estricto/ESM, NestJS 11,
  Prisma 7 con adaptador PostgreSQL, contratos Zod, lint, formato, tipos,
  pruebas, build y GitHub Actions. Código y pruebas organizados por carpetas;
  ver [arquitectura](docs/architecture.md).
- **M01 — Merchant & Integrations:** autenticación real con usuarios de
  Supabase Auth, verificación de JWT asimétricos mediante JWKS, membresías
  locales ADMIN/VIEWER, configuración del merchant y comprobación protegida
  de OAuth/lectura de disputas PayPal Sandbox. Hay un usuario administrador
  provisionado; sus credenciales permanecen fuera de Git.
- **Políticas:** investigaciones y presentaciones deshabilitadas por defecto;
  aprobación humana obligatoria. M01 no implementa el Submission Guard de M08.
- **M02 — Event Ingestion:** endpoint público autenticado por firma PayPal,
  validación de cabeceras y cuerpo original, verificación oficial por postback,
  persistencia transaccional de `WebhookEvent` + `IngestionJob`, deduplicación,
  detección de contenido conflictivo, rollback y RLS en sus tablas.
- **Comunicación M01–M02:** M02 usa la interfaz pública de M01 para obtener
  contexto del merchant y OAuth. No accede a credenciales desde el frontend.
- **M03 — Transaction Manager:** consumidor transaccional de capturas, órdenes
  comerciales, vinculación, idempotencia y consultas por merchant. Readiness dinámico
  con cobertura, faltantes y contradicciones para una captura/un paquete por pedido.
- **M04 — Evidence Vault:** expedientes JSON y archivos PDF/PNG/JPEG privados,
  origen, hashes y versiones mediante interfaz pública. Storage real verificado
  con un archivo del usuario. Conectores comerciales siguen pendientes.
- **Infraestructura:** PostgreSQL, Auth y Storage privado de Supabase configurados, siete
  migraciones aplicadas, con conexión TLS y CA oficial. Backend publicado en
  Render Free, Virginia, con despliegue desde `main` después de pasar CI.

### Verificado con servicios externos reales

- API: <https://resolve-ai-api-ybmj.onrender.com/api>.
- Readiness: `GET /api/health/ready` devuelve HTTP 200 consultando PostgreSQL.
- Login Supabase real y acceso ADMIN comprobados; acceso sin sesión HTTP 401.
- OAuth PayPal `CONNECTED` y lectura de disputas `AVAILABLE`, HTTP 200.
  Esto comprueba acceso a la API, no una disputa elegible para enviar evidencia.
- Webhook registrado en la app Sandbox:
  `https://resolve-ai-api-ybmj.onrender.com/api/webhooks/paypal`, solo POST.
  Eventos: `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`,
  `CUSTOMER.DISPUTE.UPDATED` y `CUSTOMER.DISPUTE.RESOLVED`.
- Pago de prueba de **1 USD ficticio**, aprobado por el usuario y capturado
  con estado `COMPLETED`: orden `5Y118346C7856021V`, captura
  `4TD91052PF072424A`. Fue una operación de prueba externa a las funciones
  normales de ResolveAI; no se añadió una función de cobro al producto.
- Evento genuino `WH-1YS32612YL8319623-7XB699471K872161N` recibido, verificado
  y persistido con un trabajo `TRANSACTION_CAPTURED`. Reenvío confirmado por
  PayPal con `SUCCESS`/HTTP 200; PostgreSQL conservó un evento y un trabajo.
- La prueba detectó un rechazo inicial de firma por reordenamiento de campos
  durante la validación. Se corrigió preservando el objeto original validado,
  se añadió regresión y se desplegó la corrección (`34e908b`, PR #5).
- Última validación de código: **148 pruebas unitarias/HTTP y 64 pruebas con
  PostgreSQL aprobadas**, además de lint, formato, tipos, Prisma y build.
  Las suites automatizadas usan PayPal/JWKS/Storage MOCK identificados; las
  pruebas externas de pago, firma y reenvío usaron PayPal Sandbox real. Una foto
  del usuario se recuperó desde Render/Storage real con bytes y hashes idénticos.

### Límites y siguiente paso

- **M04 es parcial; M05–M07 y M09 siguen pendientes.** M03 consume capturas
  verificadas; los trabajos de disputas permanecen `QUEUED`. Hay expedientes
  estructurados, pero no consumidores de disputas, Investigator, Verifier ni
  auditoría completa. M08 (Submission Guard) está implementado y desplegado,
  pero requiere que M06 devuelva veredicto `APPROVED` antes de poder enviar
  evidencia a PayPal.
- Se registraron eventos de disputas, pero no se ha demostrado una entrega
  genuina de disputa ni una llamada real a `provide-evidence`.
- OpenAI y el frontend no están integrados en este backend. Storage privado sí.
  No se instaló pg-boss; la cola actual es una outbox persistida en PostgreSQL.
- Swagger está desactivado en Render. El servicio Free puede suspenderse por
  inactividad. CORS sigue configurado para `http://localhost:3000`; al publicar
  el frontend habrá que configurar su origen exacto.
- El repositorio sigue **privado**; publicación, licencia y video de entrega
  siguen pendientes. No cambiar su visibilidad sin autorización del equipo.
- **Siguiente paso recomendado:** completar conectores y fuentes comerciales de M04,
  y avanzar hacia Investigator/Verifier sobre los originales persistidos.

Detalles operativos y evidencia: [M01](docs/m01-merchants.md),
[M02](docs/m02-event-ingestion.md), [despliegue](docs/deployment.md) y
[validación](docs/validation.md). No incluir secretos, tokens ni contraseñas
en este documento.

## 0. Instrucciones esenciales para Codex

Antes de implementar cualquier tarea:

1. Lee `information.md`, revisa la estructura real del repositorio, y comprueba los archivos `AGENTS.md` aplicables, si existen.
2. **No supongas que el código ya existe.** Distingue entre requisitos planificados, código implementado y funcionalidad verificada.
3. Confirma el alcance de la tarea, identifica el módulo propietario y utiliza contratos públicos para interactuar con otros módulos. Haz cambios pequeños, coherentes y probables de integrar mediante Pull Request.
4. Mantén el sistema como **un solo backend NestJS modular**, no microservicios. No introduzcas herramientas o infraestructura adicionales sin justificar la necesidad.
5. No inventes respuestas de PayPal ni datos de evidencia. Los fixtures/simulaciones deben estar claramente marcados como **DEMO / MOCK**.
6. Antes de llamar APIs externas, confirma forma de los endpoints, estados permitidos y requisitos de permisos contra la documentación oficial y la implementación existente.
7. Nunca construyas una ruta que permita que el modelo de IA envíe evidencia a PayPal saltándose las validaciones deterministas y las autorizaciones.
8. Ejecuta pruebas correspondientes y comunica qué se probó realmente, qué quedó simulado y qué falta integrar.
9. Si cambia un contrato compartido, actualiza su schema, tipos, tests y consumidores, o evita el cambio.
10. No reestructures carpetas de otros equipos ni reescribas módulos no relacionados sin una necesidad demostrable.

**Regla de priorización:** un flujo end-to-end real, demostrable y honesto vale más que muchas funcionalidades incompletas.

---

## 1. Visión del producto

**Nombre:** ResolveAI

**Tagline:** **Be ready for disputes before they happen.**

**Descripción:** ResolveAI es un agente de preparación y representación de disputas para comercios que usan PayPal. Mantiene un expediente de evidencias desde que se captura un pago; cuando un comprador abre una disputa en PayPal, investiga el caso, recopila información adicional, valida independientemente la calidad/suficiencia de la evidencia y prepara o presenta una respuesta en nombre del comerciante, sujeto a permisos y controles.

### Actores

- **Comerciante:** conecta integraciones, consulta protección de transacciones, revisa alertas, aprueba/envía acciones y ve resultados.
- **Comprador:** puede iniciar disputas directamente **en PayPal**; no opera ResolveAI ni autoriza a ResolveAI a abrir disputas.
- **PayPal:** origen de pagos, disputas, estados y recepción de evidencia; el sistema oficial decide resultados cuando corresponda.
- **Investigator Agent:** recopila y analiza registros para preparar evidencia.
- **Verifier Agent:** audita de manera independiente las afirmaciones y suficiencia de lo recopilado.
- **Submission Guard:** código determinista que valida condiciones antes de enviar a PayPal.

### No objetivos del MVP

- ResolveAI **nunca abre disputas** en nombre de compradores.
- No decide formalmente quién gana, ni garantiza el resultado de una disputa.
- No ejecuta reembolsos, pagos, conciliaciones financieras ni apelaciones automáticas.
- No necesita multi-tenant real en el MVP: se usa **un merchant de PayPal Sandbox**.
- No necesita integraciones comerciales reales con Shopify, paqueterías o SaaS para el demo: puede utilizar una base de datos de pedidos/envíos **simulada y etiquetada**.
- No construir paneles complejos de BI, microservicios, Kubernetes ni flujos de onboarding de producción.

### Audiencia inicial

Pequeños y medianos comercios e-commerce que reciben pagos con PayPal y deben responder disputas con evidencia de orden, pago y entrega.

### Disputa prioritaria

**Item Not Received / Producto no recibido (INR)** para mercancía física. Es el primer caso a soportar porque tiene evidencia estructurada (orden, captura, tracking, envío, entrega) y muestra el valor proactivo del producto.

---

## 2. Criterios del PayPal AI Hackathon

La entrega requiere integración sustantiva con PayPal, uso sustantivo de IA, demo funcional reproducible, repositorio público con código y licencia, instrucciones de instalación y video público menor de 3 minutos. Se evaluarán implementación técnica, diseño, impacto, innovación y presentación. Trabajar para la **demo antes de optimizaciones de producción**.

**Historia del demo recomendada:**

1. Un pago capturado llega desde PayPal (o se selecciona un pago Sandbox real ya existente).
2. ResolveAI genera expediente y detecta que falta evidencia de envío/entrega.
3. Investigator encuentra un registro adicional en el sistema comercial de prueba; la preparación mejora.
4. Un **comprador inicia la disputa en PayPal** y ResolveAI detecta ese caso.
5. Investigator prepara pruebas específicas; Verifier revisa originales y explica qué cumple/falta.
6. Submission Guard deja enviar solo cuando el estado y permisos lo permiten; se registra el resultado **real** de la llamada Sandbox si está disponible.
7. Se muestra un segundo caso con evidencia contradictoria donde el Verifier bloquea el envío y pide intervención humana.

**Riesgo crítico:** validar cuanto antes si existen disputas de prueba accesibles en las cuentas Sandbox y si la API permite `provide-evidence` en el estado concreto. Si el flujo de creación de disputa de Sandbox no está habilitado, no afirmar que se ejecutó. Usar fixtures SOLO para el segmento imposible de demostrar, con señalización visual, e intentar mantener una operación real de PayPal en el demo.

---

## 3. Stack acordado

| Capa | Tecnología | Propósito |
|---|---|---|
| Lenguaje | TypeScript | Frontend, backend y contratos |
| Frontend | Next.js + React | App web merchant |
| Componentes | Tailwind CSS + shadcn/ui | UI consistente |
| Tablas | AG Grid Community | Transacciones y disputas |
| Estado HTTP | TanStack Query | Fetch, caché, polling |
| Backend | Node.js + NestJS | Monolito modular, REST, eventos |
| Base de datos | PostgreSQL en Supabase | Transacciones, disputas, jobs, auditoría |
| ORM | Prisma | Modelado y migraciones |
| Almacenamiento | Supabase Storage privado | Evidencia y documentos |
| Modelos IA | OpenAI Responses API | Investigator y Verifier con tools / structured output |
| Validación | Zod | Contratos entre módulos y entradas externas |
| Trabajos | pg-boss (si la integración lo requiere) | Webhooks, retries, investigaciones asincrónicas |
| PayPal | PayPal Developer APIs / Sandbox | Capturas, webhooks, consultas y evidencia de disputas |
| Tests | Vitest y Playwright | Unitarios, integración y E2E |
| API docs | Swagger/OpenAPI | Especificar contratos internos |
| Monorepo | pnpm workspaces | Dependencias y paquetes compartidos |
| Control | GitHub + GitHub Actions | PRs, CI y repositorio público |
| Hosting | Vercel (web), Render (API/worker), Supabase (DB/Storage) | Demo desplegado |

**No agregar por defecto:** LangChain/LangGraph, Python, Redis, Kafka, Terraform, microservicios, contenedores complejos. Puede usarse Docker para desarrollo local, sin volverlo requisito para cada integrante.

---

## 4. Estructura actual del repositorio backend

```text
paypal-mediator-backend/
├── apps/
│   └── api/                        # Backend NestJS único
│       ├── prisma.config.ts
│       ├── prisma/                 # Schema y siete migraciones
│       ├── test/                   # unit/, http/, integration/, fixtures/
│       └── src/
│           ├── modules/
│           │   ├── merchants/
│           │   ├── event-ingestion/
│           │   ├── transactions/
│           │   ├── evidence/
│           │   └── health/
│           ├── common/             # Auth, guards, errores, logging
│           └── main.ts
├── packages/
│   └── contracts/                  # Schemas Zod y tipos compartidos
├── docs/                           # Diagramas, decisiones, API y demo
├── .github/workflows/              # CI con PostgreSQL real de pruebas
├── render.yaml                     # Configuración de despliegue de la API
├── information.md                  # Este documento
├── .env.example                    # Solo placeholders, nunca secretos
├── pnpm-workspace.yaml
└── README.md
```

El frontend vive en un repositorio separado. Las carpetas de M05–M09 se crearán
cuando se implementen; no añadir carpetas vacías que aparenten trabajo terminado.

---

## 5. Los 10 módulos funcionales

| ID | Módulo | Responsabilidad | Entregable mínimo |
|---|---|---|---|
| M01 | Merchant & Integrations | Merchant, configuración, autorización, integración PayPal/tienda | Cuenta demo y estado de conexión |
| M02 | Event Ingestion | Recibir/verificar/deduplicar webhooks | Evento persistido y trabajo en cola |
| M03 | Transaction Manager | Capturas de pago, órdenes y readiness proactiva | Lista y detalle de transacciones |
| M04 | Evidence Vault | Guardar evidencia, origen, integridad y versiones | Expediente consultable |
| M05 | Investigator Agent | Buscar fuentes, hechos, faltantes y borrador | `InvestigationResult` trazable |
| M06 | Verifier Agent | Revisión independiente, contradicciones, cobertura y veredicto | `VerificationResult` estructurado |
| M07 | Dispute Orchestrator | Máquina de estados y coordinación de workflow | Gestión de cada disputa |
| M08 | PayPal Submission | Guard de seguridad y envío a PayPal | Resultado con ID y log de API |
| M09 | Monitoring & Audit | Actividad, métricas, eventos, errores, seguimiento | Timeline auditable |
| M10 | Merchant Dashboard | UX e integración frontend de M01–M09 | Pantallas end-to-end |

En backend M01–M09 son módulos NestJS dentro del **mismo servicio**. M01, M02,
M03, M04 y M08 están implementados; M03 incluye capturas, órdenes y readiness;
M04 tiene la base estructurada y archivos privados. M05–M07 y M09 son alcance
futuro. M10 vive en el repositorio del frontend. Evitar que un módulo escriba
las tablas privadas de otro sin una interfaz definida.

### Interfaces entre módulos

```text
PayPal Webhooks → Event Ingestion → Transaction Manager / Dispute Orchestrator
                                        ↓                  ↓
                                  Evidence Vault ← Investigator Agent
                                        ↓                  ↓
                                  Originales → Verifier Agent
                                                       ↓
                                               Dispute Orchestrator
                                                       ↓
                                                Submission Guard
                                                       ↓
                                                 PayPal Disputes
                                                       ↓
                                                Monitoring & Audit
                                                       ↕
                                                Merchant Dashboard
```

---

## 6. Flujos funcionales

### 6.1 Preparación preventiva (antes de una disputa)

1. Se captura un pago en PayPal.
2. M02 recibe el evento validado **o** se sincroniza una transacción Sandbox existente.
3. M03 crea/vincula `Transaction` y la orden del comerciante.
4. M04 crea `EvidenceDossier` con referencias a pago, pedido, tracking y entrega disponibles.
5. M05 recopila automáticamente evidencia disponible y señala vacíos.
6. M06 puede aplicar una revisión de **readiness documental** para detectar contradicciones y faltantes antes de una disputa.
7. Se muestra un checklist determinista de preparación en la UI.
8. Si cambia el estado del envío, el expediente se actualiza; **no se crea disputa**.

**No mostrar readiness = probabilidad de ganar.** Es cobertura documental respecto al checklist y a los datos que se conocen.

### 6.2 Respuesta ante disputa abierta por el comprador

1. El comprador inicia la disputa directamente en PayPal.
2. Se recibe webhook o se descubre la disputa al sincronizar.
3. Se recuperan detalles de PayPal y **las acciones disponibles en su estado real**.
4. M07 vincula la disputa al expediente existente por identificadores confiables de transacción.
5. M05 reúne documentos adicionales específicos del motivo y produce `InvestigationResult`.
6. M06 revisa **las fuentes originales**, no solo el relato de M05, y genera `VerificationResult`.
7. Si hay faltantes: nuevo ciclo de investigación con límite de intentos, solicitud al comerciante o escalamiento.
8. Si el Verifier considera el expediente aprobado: M08 vuelve a comprobar requisitos de API, permisos, estado/acción y aprobación merchant según configuración.
9. Si está permitido y autorizado, se envía evidencia por PayPal Disputes API.
10. Se registra confirmación o error; se continúa monitoreando el resultado oficial.

### 6.3 Casos en que no se debe enviar

- Falta evidencia requerida para el caso o existe una contradicción crítica.
- Los IDs de pago, orden o tracking no pueden emparejarse confiablemente.
- El modelo no puede respaldar una afirmación con registros verificables.
- No existe autorización del comerciante para ese tipo de acción.
- La disputa no está en un estado que permita proporcionar evidencia.
- Ya se registró una presentación equivalente: no repetir a ciegas.
- Error de API cuya resolución requiera validación humana.

### 6.4 Submission Guard y envío a PayPal (M08)

M08 implementa el Submission Guard: código determinista que valida condiciones
**antes** de enviar cualquier evidencia a PayPal. Nunca permite que el modelo de
IA envíe evidencia saltándose las validaciones deterministas y las autorizaciones.

**Flujo de envío:**

1. El Verifier (M06) debe haber devuelto veredicto `APPROVED` sobre la disputa.
2. M08 verifica que el merchant tenga `allowSubmissions=true` y aprobación humana
   configurada (requerida por defecto).
3. M08 verifica que el estado y etapa de PayPal permitan `provide-evidence`
   (ej. `WAITING_FOR_SELLER_RESPONSE` / `INQUIRY` o `CHARGEBACK`).
4. M08 verifica que la disputa esté vinculada (`LINKED`) a una transacción de M03.
5. M08 verifica que no exista una presentación previa para la misma disputa
   (idempotencia).
6. Si todo pasa, se llama a `POST /v1/customer/disputes/{id}/provide-evidence`
   de PayPal Sandbox con los IDs de evidencia verificados.
7. El resultado (`SUBMITTED` / `BLOCKED` / `FAILED`) se registra en la tabla
   `submissions` y en la auditoría M09 con actor, momento, acción y resultado.

**Endpoint:** `POST /api/disputes/:id/submit` — requiere JWT y rol ADMIN.
**Endpoint de consulta:** `GET /api/disputes` lista disputas con su estado de
enlace y veredicto.

---

## 7. Verificación independiente: requisito crítico

**Nunca se permite que Investigator se autocertifique.** M05 y M06 deben tener responsabilidades y herramientas separadas. No es suficiente hacer una segunda pregunta al mismo contexto: M06 debe recuperar y contrastar **datos fuente** mediante el vault/adaptadores.

### 7.1 Checklist del Verifier

1. **Procedencia:** fuente, ID externo, fecha de captura, referencia a documento y permisos de lectura.
2. **Integridad:** contenido presente y sin manipulación; opcionalmente hash SHA-256 del archivo original.
3. **Identidad:** correspondencia de `paypalTransactionId`, `merchantOrderId`, tracking y comprador según campos disponibles.
4. **Consistencia:** ausencia de incompatibilidades en fechas, importes, tracking, estado o dirección.
5. **Relevancia:** evidencia relacionada con el motivo de disputa y lo que PayPal solicita.
6. **Cobertura:** evidencia obligatoria completa o explícitamente no disponible.
7. **Explicabilidad:** cada afirmación del borrador apunta a al menos un `EvidenceItem`.
8. **Estado:** hallazgos vigentes y no obsoletos al momento de enviar.

### 7.2 Resultado del Verifier

- `APPROVED`: expediente supera controles internos para consideración de envío; **no** significa victoria ni aceptación por PayPal.
- `INCOMPLETE`: se requieren más datos; detallar campos faltantes y próximos pasos.
- `REJECTED`: evidencia contradictoria/no confiable o afirmaciones no sustentadas; bloquear y escalar.

**Diseño híbrido:** el LLM evalúa relevancia/consistencia semántica; código TypeScript determinista valida IDs, campos requeridos, restricciones y permisos. Si hay discrepancia crítica, prevalece el bloqueo.

### 7.3 Bucle controlado

`Investigate → Verify → (APPROVED | INCOMPLETE | REJECTED)`

Ante `INCOMPLETE`, permitir un número pequeño y configurado de nuevas investigaciones (por ejemplo `MAX_INVESTIGATION_ROUNDS=2`). Si el dato no existe, escalar; nunca inventarlo. `REJECTED` requiere revisión humana salvo una corrección verificable de fuentes.

---

## 8. Contratos de dominio iniciales (propuesta)

Ubicarlos en `packages/contracts` y definir schemas Zod. Nombres ilustrativos y ajustables con acuerdo del equipo.

```ts
export type EvidenceStatus = "FOUND" | "VERIFIED" | "MISSING" | "CONTRADICTORY";
export type VerificationVerdict = "APPROVED" | "INCOMPLETE" | "REJECTED";
export type AgentRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "ESCALATED";

export interface EvidenceItem {
  id: string;
  dossierId: string;
  type: string; // Ej. PAYMENT_RECORD, ORDER_CONFIRMATION, TRACKING, PROOF_OF_DELIVERY
  sourceSystem: string;
  externalReference?: string;
  storagePath?: string; // Ubicación privada, no URL pública
  retrievedAt: string; // ISO8601
  status: EvidenceStatus;
  contentHash?: string;
  metadata: Record<string, unknown>;
}

export interface InvestigationResult {
  id: string;
  disputeId: string;
  agentRunId: string;
  collectedEvidenceIds: string[];
  findings: Array<{
    statement: string;
    evidenceIds: string[];
  }>;
  missingEvidence: string[];
  suggestedResponse: string; // Borrador; NO enviado
  completedAt: string;
}

export interface VerificationResult {
  id: string;
  disputeId: string;
  investigationId: string;
  verdict: VerificationVerdict;
  verifiedEvidenceIds: string[];
  missingRequirements: string[];
  contradictions: string[];
  reasons: Array<{
    code: string;
    explanation: string;
    evidenceIds: string[];
  }>;
  verifiedAt: string;
}

export interface SubmissionResult {
  disputeId: string;
  status: "SUBMITTED" | "BLOCKED" | "FAILED";
  paypalRequestId?: string;
  paypalResponseStatus?: number;
  submittedAt?: string;
  message?: string;
}
```

### Entidades de persistencia sugeridas

`Merchant`, `MerchantIntegration`, `Transaction`, `MerchantOrder`, `EvidenceDossier`, `EvidenceItem`, `Dispute`, `AgentRun`, `AgentEvent`, `Investigation`, `Verification`, `Submission`, `WebhookEvent`, `AuditLog`.

Relaciones clave:

- `Transaction` 1→1/varios `EvidenceDossier` según estrategia de versiones.
- `Dispute` se vincula a `Transaction` y al expediente usado para defenderla.
- `Investigation` referencia IDs de evidencia; `Verification` referencia investigación + evidencia.
- `Submission` referencia la verificación aprobada, la autorización aplicable y la respuesta de PayPal.
- `AuditLog` es append-only; no sobrescribir el historial.

Crear índices únicos para IDs externos que requieren idempotencia, y definir explícitamente el alcance merchant de cada clave.

---

## 9. Máquinas de estados

### 9.1 Preparación de expediente

`CREATED → COLLECTING → READY | INCOMPLETE`

La llegada de nueva evidencia puede producir `INCOMPLETE → COLLECTING` o reevaluación de un expediente `READY`. Un expediente `READY` **no prueba** que una futura disputa sea defendible.

### 9.2 Flujo interno de disputa

```text
DETECTED
  → INVESTIGATING
    → VERIFYING
      → INCOMPLETE → INVESTIGATING / NEEDS_REVIEW
      → REJECTED → NEEDS_REVIEW
      → APPROVED → READY_TO_SUBMIT
        → (si requiere aprobación) AWAITING_MERCHANT_APPROVAL
        → SUBMITTING
          → SUBMITTED → AWAITING_PAYPAL → CLOSED
          → SUBMISSION_FAILED → NEEDS_REVIEW / RETRY_SAFELY
```

El estado oficial de PayPal se guarda **por separado** (`paypalStatus`, `paypalStage`, etc.) y solo se actualiza desde respuestas PayPal; nunca debe confundirse con `INVESTIGATING`, que es estado local. No asumir que todos los casos admiten el mismo endpoint/acción.

---

## 10. Frontend — pantallas y UX

### Layout base

Barra lateral: `Overview`, `Transactions`, `Disputes`, `Agent Activity`, `Settings`. Navegación a detalles desde tablas. Mostrar Sandbox claramente y distinguir datos MOCK vs datos reales.

| Ruta sugerida | Pantalla | Elementos imprescindibles |
|---|---|---|
| `/` o `/overview` | Overview | KPIs de preparación, actividad reciente, alertas, disputas a revisar |
| `/transactions` | Transactions | Tabla AG Grid, readiness checklist resumido, filtros |
| `/transactions/[id]` | Transaction Detail | Datos de pago/orden, evidence vault, checklist, timeline, fuente de cada prueba |
| `/disputes` | Disputes | Lista, motivo, monto, deadline, estado interno, estado PayPal, necesidad de atención |
| `/disputes/[id]` | Dispute Detail | Caso, investigación, evidencias, Verifier, respuesta, envío, timeline |
| `/activity` | Agent Activity | Eventos del agente, tool calls, éxito/error, timestamp |
| `/settings` | Settings | PayPal Sandbox, fuente de datos, política de aprobación |

### Dispute Detail: 4 secciones internas

- **Overview:** reclamo, tiempo restante, estados y recomendación.
- **Evidence:** documentos y relaciones entre afirmación ↔ fuentes originales.
- **Agent Log / Verification:** pasos de Investigator, checklist del Verifier, faltantes, contradicciones, motivos de bloqueo.
- **Submission:** borrador, revisión, controles de autorización, botón condicionado, resultado real de API.

### Experiencia de usuario obligatoria

- Mostrar con claridad `Investigator → Verifier → Submission Guard`.
- Botón de envío bloqueado cuando el verificador no haya aprobado o falten permisos.
- Distinguir `READY` documental de `APPROVED` para responder a un caso concreto.
- Nunca mostrar `SUBMITTED` hasta recibir confirmación de API y registrar el resultado.
- Mostrar logs útiles para demo, evitando datos personales y secretos.
- Los fixtures deben permitir visualizar al menos un expediente exitoso y otro bloqueado por contradicción.

---

## 11. Contratos HTTP internos

### Rutas implementadas de la base, M01, M02 y M03

| Método | Ruta | Protección / comportamiento |
|---|---|---|
| GET | `/api/health` | Liveness; no afirma conectividad a servicios externos |
| GET | `/api/health/ready` | Readiness con consulta PostgreSQL |
| GET | `/api/merchants/me` | JWT Supabase y membresía activa |
| PATCH | `/api/merchants/me/settings` | JWT y rol ADMIN |
| GET | `/api/settings/integrations` | JWT y membresía; sin secretos |
| POST | `/api/settings/integrations/paypal/check` | JWT y rol ADMIN; OAuth/lectura real y resultado persistido |
| POST | `/api/webhooks/paypal` | Sin JWT; exige firma PayPal válida antes de guardar/encolar |
| GET | `/api/transactions` | JWT y membresía; listado paginado y filtro por captura |
| GET | `/api/transactions/:id` | JWT y membresía; detalle del merchant con checklist documental |
| GET/POST | `/api/orders` | Lectura por membresía; registro de pedido solo ADMIN |
| GET | `/api/orders/:id` | Pedido comercial del merchant |
| GET/POST | `/api/transactions/:id/evidence` | Expediente/historial; escritura de tracking y entrega solo ADMIN |
| POST | `/api/transactions/:id/refresh-evidence` | ADMIN; vinculación y registros base de evidencia síncronos |

### Rutas objetivo del producto

**Estos son endpoints de ResolveAI, NO URLs oficiales de PayPal.** Versionar/documentar con OpenAPI e implementar inicialmente contra fixtures si los otros módulos aún no están listos.

| Método | Ruta | Respuesta o comportamiento |
|---|---|---|
| GET | `/api/health` | Salud del backend |
| GET | `/api/dashboard` | KPIs, actividad y alertas |
| GET | `/api/transactions` | Página de transacciones |
| GET | `/api/transactions/:id` | Detalle + readiness + evidencia |
| POST | `/api/transactions/:id/refresh-evidence` | Encolar actualización autorizada |
| GET | `/api/disputes` | Lista con estados internos y oficiales |
| GET | `/api/disputes/:id` | Detalle completo |
| GET | `/api/disputes/:id/investigation` | Findings, tool events y faltantes |
| GET | `/api/disputes/:id/verification` | Veredicto, checklist, razones |
| POST | `/api/disputes/:id/investigate` | Encolar o continuar investigación autorizada |
| POST | `/api/disputes/:id/approve` | Guardar aprobación del merchant |
| POST | `/api/disputes/:id/submit` | Validar guard + enviar si corresponde |
| GET | `/api/activity` | Eventos paginados |
| GET | `/api/settings/integrations` | Conexiones y permisos (sin secretos) |
| POST | `/api/webhooks/paypal` | Webhook firmado de PayPal; acceso público restringido por validación |

Recomendaciones: esquema de error uniforme `{ code, message, details?, requestId }`, paginación y filtrado desde el inicio, protección contra escrituras repetidas y autorizaciones merchant antes de acciones con efecto.

---

## 12. Integración PayPal y límites de Sandbox

**Documentación a comprobar durante implementación:**

- PayPal Disputes integración: https://developer.paypal.com/platforms/disputes/integrate-disputes/
- PayPal Disputes API: https://developer.paypal.com/api/customer-disputes/v1/
- PayPal uso de Disputes API: https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/
- Portal developer: https://developer.paypal.com/

Operaciones relevantes para este MVP (verificar disponibilidad, permisos y payload actual):

- `GET /v1/customer/disputes`
- `GET /v1/customer/disputes/{id}`
- `POST /v1/customer/disputes/{id}/provide-evidence` (solo en estados/acciones permitidos)
- Webhooks de pago capturado y de disputas; verificar los nombres de eventos en configuración.

**Reglas de implementación:**

1. Utilizar credenciales Sandbox a nivel servidor; no exponer secretos al navegador.
2. Verificar autenticidad/firma de webhook con el mecanismo oficial de PayPal, almacenar ID de evento y deduplicar.
3. Confirmar las acciones disponibles en los detalles del caso **justo antes** de enviar.
4. No crear ninguna disputa como parte del comportamiento normal de ResolveAI; el comprador la abre por PayPal.
5. El remitente autorizado es el comerciante Sandbox configurado; soporte multiparty/terceros es fase posterior y necesita permisos y consentimiento correctos.
6. Guardar IDs y estados reales de respuesta; no simular una recepción exitosa.
7. Emplear reintentos solo cuando sean seguros/idempotentes. Ante resultados ambiguos, consultar el estado antes de reenviar.
8. No suponer que un PDF o archivo arbitrario satisface la evidencia esperada; enviar conforme a tipos permitidos por PayPal.

---

## 13. Seguridad, privacidad y resiliencia

- Guardar `PAYPAL_CLIENT_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL` y claves de storage solo en variables de entorno del servidor.
- `NEXT_PUBLIC_*` solo para valores realmente públicos.
- No subir `.env` ni datos reales de clientes al repositorio público. Proveer `.env.example` con placeholders.
- Documentos en bucket privado; acceder mediante permisos server-side o URLs firmadas temporales.
- El agente solo debe tener herramientas de lectura sobre evidencia y generación de borradores; no acceso directo a secretos ni a la función de envío.
- Tratar mensajes y documentos de comprador/comerciante como **contenido no confiable**: no obedecer instrucciones incrustadas en PDFs, correos o notas; son datos para investigar, no órdenes para el agente.
- Cada afirmación del modelo debe enlazar a `EvidenceItem.id`; si falta respaldo, presentarla como hipótesis no verificada y no enviarla.
- Auditoría de acciones sensibles: actor, momento, acción, razones, aprobación y resultado.
- Endpoint de webhook rápido: validar/guardar/encolar y responder; la investigación corre asíncronamente.
- Comportamiento seguro ante caídas de IA o PayPal: fallar cerrado para envíos; conservar expedientes y errores recuperables.
- Diseñar límites de iteraciones del agente, timeouts, control de costos y sanitización de logs.

---

## 14. Desarrollo colaborativo y Git

El repositorio tendrá un solo `main` estable; **no** mantener ramas largas permanentes por módulo. Usar ramas por feature y PRs pequeños:

- `feat/frontend-dispute-detail`
- `feat/paypal-dispute-webhook`
- `feat/evidence-vault`
- `feat/investigator-agent`
- `feat/verifier-checklist`
- `feat/submission-guard`

### Convenciones

- No modificar `packages/contracts` sin coordinar con consumidores.
- Actualizar/añadir tests en cada cambio de reglas de negocio.
- No dejar funciones ficticias que silenciosamente devuelvan éxito.
- Para endpoints sin implementar, utilizar adaptadores mock explícitos en desarrollo; no confundirlos con integraciones reales.
- Revisar lint, typecheck, tests y build antes de merge.
- Documentar nuevas variables de entorno en `.env.example`.
- Mantener imports entre módulos a través de sus interfaces públicas.

---

## 15. Testing y criterios de aceptación

### Pruebas fundamentales

1. **Webhook duplicado:** un evento genera a lo sumo un trabajo lógico, sin evidencia duplicada.
2. **Pago sin tracking:** el expediente permanece incompleto y muestra faltante.
3. **Llegada de tracking válido:** expediente se actualiza y mantiene historial.
4. **Tracking de otra orden:** Verifier detecta contradicción y bloquea envío.
5. **Documento faltante:** Verifier devuelve `INCOMPLETE` con justificación.
6. **Evidencia suficiente:** Verifier devuelve `APPROVED` con IDs de evidencia.
7. **Estado PayPal no elegible:** Submission Guard bloquea aun con `APPROVED`.
8. **Sin aprobación merchant cuando se requiere:** envío bloqueado.
9. **Error en PayPal:** se muestra `FAILED` y el error; no éxito falso.
10. **Respuesta real de PayPal Sandbox:** se guarda código, referencia y momento; UI refleja estado con precisión.
11. **Prompt injection en evidencia:** instrucciones dentro del documento no provocan herramientas o acciones no autorizadas.
12. **Frontend demo:** todos los pasos se muestran con estados coherentes y se pueden repetir.

### Definición de terminado para el MVP

- [x] Un merchant Sandbox configurado y operativo.
- [x] Al menos una operación API PayPal realmente funcional, demostrable y documentada: OAuth, lectura de disputas y pago/webhook Sandbox. La presentación de evidencia sigue pendiente.
- [ ] Expediente preventivo persistido y visualizado en Transactions.
- [ ] Investigator recupera datos de orden y shipping (pueden ser MOCK etiquetados).
- [ ] Verifier revisa evidencia de fuente, no solo una respuesta del investigador.
- [ ] Guard impide envíos no autorizados/contradictorios.
- [ ] Dispute Detail muestra progreso, evidencia, verificación y resultado.
- [ ] Casos exitoso y bloqueado reproducibles con fixtures de demo.
- [x] README y guías con setup local, variables de entorno, comandos y limitaciones Sandbox de los módulos implementados.
- [ ] Repositorio público, licencia visible y video funcional de menos de 3 minutos.

---

## 16. Despliegue

- **Render, operativo:** `apps/api`, servicio `resolve-ai-api`, HTTPS y webhook
  público. `npm run start:render` aplica migraciones y arranca la API; readiness
  es `/api/health/ready`. Secretos y CA se configuran fuera de Git.
- **Supabase, operativo:** PostgreSQL, Auth y Storage privado; originales recuperados sin alteraciones.
- **PayPal Sandbox, operativo:** OAuth, lectura de disputas, suscripción de
  webhooks y prueba genuina de captura/entrega. No se habilitó Live.
- **Frontend/Vercel:** repositorio separado; despliegue no verificado aquí.
- **OpenAI y worker consumidor:** pendientes de sus módulos.

**Variables estimadas para el producto completo:** los valores y variables
actualmente soportados se documentan en `.env.example` y `docs/deployment.md`.
OpenAI y los límites de agentes del ejemplo son para módulos futuros. Storage
usa `SUPABASE_SECRET_KEY` solo en backend (o JWT service role legado). La
verificación de usuarios usa `SUPABASE_URL`/JWKS y no necesita la clave de Storage.

```dotenv
# Backend
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB
OPENAI_API_KEY=replace-me
PAYPAL_CLIENT_ID=replace-me
PAYPAL_CLIENT_SECRET=replace-me
PAYPAL_WEBHOOK_ID=replace-me
PAYPAL_ENV=sandbox
SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-me
EVIDENCE_BUCKET=private-evidence
MAX_INVESTIGATION_ROUNDS=2
CORS_ORIGIN=http://localhost:3000

# Frontend (solo datos públicos)
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api
```

No copiar valores reales al repo. Los nombres exactos deben alinearse con los módulos implementados.

---

## 17. Plan de implementación por dependencias

**Fase A — Base común del backend, completada:** workspace pnpm, NestJS,
contratos compartidos, Prisma, lint/tests, health y despliegue HTTPS. Next.js
corresponde al otro repositorio.

**Fase B — Core PayPal, parcial:** M01 y M02 implementados y verificados con
pago/webhook genuino. Sigue pendiente una disputa elegible y comprobar
`provide-evidence` en su estado real.

**Fase C — Evidence readiness:** transactions, orders demo, evidence vault, checklist, overview y transaction detail.

**Fase D — AI:** Investigator con tools limitadas, Verifier independiente, veredictos, audit trail y pruebas de contradicción.

**Fase E — Defense:** orquestador, approvals, Submission Guard, intento real de envío, respuesta, historial.

**Fase F — Demo & delivery:** caso completo, caso bloqueado, UX pulida, deploy, README, licencia, video, ensayo reproducible.

No construir funciones P1 (multi-merchant, actualizaciones avanzadas de tracking, analítica sofisticada) hasta cerrar las fases críticas.

---

## 18. Cómo pedir trabajo a Codex CLI

**Importante:** Codex detecta automáticamente `AGENTS.md` cuando existe, pero **no debe asumirse** que lee arbitrariamente `information.md` sin pedírselo. Leer explícitamente este archivo al comenzar cada sesión, o crear después un pequeño `AGENTS.md` que lo referencie.

Ejemplo de prompt para iniciar:

```text
Lee information.md y revisa la estructura actual del repositorio.
Resume el objetivo de ResolveAI, el estado real del código y los contratos existentes.
No implementes todavía: propón un plan de trabajo para el módulo [NOMBRE],
señalando dependencias, archivos afectados, pruebas y bloqueos de PayPal Sandbox.
No alteres módulos ajenos ni afirmes que una integración real está terminada
sin evidencia de ejecución.
```

Ejemplo para ejecutar una tarea:

```text
Lee information.md, los AGENTS.md aplicables y el código existente.
Implementa SOLO [FUNCIONALIDAD] dentro de [MODULO].
Respeta los schemas de packages/contracts y agrega tests.
Usa adaptador mock explícito si la API real no está disponible.
Al finalizar, informa archivos modificados, comandos de prueba y resultados reales.
```

---

## 19. Decisiones pendientes (no inventarlas)

- Integración del frontend con la autenticación real ya elegida e implementada
  en backend: Supabase Auth y JWT; no usar un Bearer fijo de demo.
- Proveedor y modelo exacto de OpenAI; elegir según costo/latencia y capacidad.
- Si PayPal Sandbox ofrece una disputa elegible para `provide-evidence` dentro del tiempo disponible.
- Implementación de M08: M01 ya exige aprobación humana y mantiene envíos
  deshabilitados por defecto; no relajar esos controles desde la IA.
- Fuente de órdenes y envíos simulada: fixtures JSON o DB seed.
- Qué se expondrá al público en demo y qué requerirá login.
- Necesidad real de separar el worker dentro de Render; inicialmente puede estar en el proceso del backend.

**Prioridad transversal:** seguridad y honestidad de la demo por encima de aparentar más autonomía de la que se implementó.

---

## 20. Referencias oficiales para validar implementación

- PayPal Disputes: https://developer.paypal.com/platforms/disputes/integrate-disputes/
- PayPal Disputes API: https://developer.paypal.com/api/customer-disputes/v1/
- PayPal API usage: https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/
- PayPal Developer Dashboard: https://developer.paypal.com/dashboard/
- NestJS: https://docs.nestjs.com/
- Next.js: https://nextjs.org/docs
- Prisma: https://www.prisma.io/docs
- OpenAI API: https://platform.openai.com/docs/
- Codex y AGENTS.md: https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex

**Último principio:** ResolveAI *se prepara antes de que exista la disputa*, *investiga cuando el comprador abre el caso* y *solo envía evidencia real, trazable, verificada y autorizada*. El resultado oficial sigue perteneciendo a PayPal.
