# Validaciones del backend

## M03 publicado en Render — 6 de noviembre de 2026

PR #6 integrado en `main` con merge `ff12287` (implementación `6c3302c`).
Las dos ejecuciones CI del PR y la ejecución de `main` `42235679015` pasaron:
`pnpm check` con **111 pruebas unitarias/HTTP**, build, generación/validación
Prisma, lint, formato y tipos; **43 pruebas PostgreSQL**, migraciones y segunda
aplicación sin pendientes. La configuración de producción habilita el worker
por defecto; `TRANSACTION_WORKER_ENABLED=false` explícito lo desactiva.

Verificación real HTTPS a las `2026-11-06T14:40:55.282Z`, después de detener el
worker temporal local:

- `GET /api/health/ready`: HTTP 200.
- Login Supabase real y `GET /api/transactions?paypalCaptureId=7HV195624A539251X`:
  HTTP 200, exactamente una transacción.
- `GET /api/transactions/762e5e48-ed95-4093-ab83-29951fdff0d3` con JWT real:
  HTTP 200, orden/captura/procedencia correctas, importe `1 USD` y checklist
  `INCOMPLETE` con los documentos faltantes.
- El mismo detalle sin sesión: HTTP 401.

La captura original fue procesada por el worker local antes del despliegue;
esta comprobación valida lectura, autorización y conectividad de M03 en Render.
No se afirma que el worker remoto haya procesado un pago nuevo en esta fase.
La imagen entregada es un informe generado desde los resultados API/DB guardados,
no una captura histórica de la interfaz de PayPal. No contiene credenciales.

## M03 — Primer incremento, 6 de noviembre de 2026

Validación local en `feat/m03-transaction-manager`, actualizada por avance directo
desde `main` (`73faa2b`). Las suites automatizadas usan PayPal MOCK;
la comprobación posterior con Sandbox real se detalla abajo. M03 no desplegado.

- `pnpm check`: correcto; generación/validación Prisma, lint, formato, tipos,
  **109 pruebas unitarias/HTTP** y build.
- Cuatro migraciones aplicadas con `pnpm db:deploy` en una base PostgreSQL 18.6
  desechable en loopback. Segunda aplicación: sin migraciones pendientes.
- `pnpm test:db`: **43 pruebas aprobadas**, incluidas nueve de M03.
- La app NestJS, las transacciones PostgreSQL y la comunicación M02–M03 son
  reales. Firma PayPal/OAuth y JWT/JWKS usan mocks explícitos.
- Comprobados duplicados concurrentes, conflicto sin sobrescritura, datos
  inválidos, rollback y reintento, savepoint de rechazos, acceso VIEWER,
  aislamiento de merchant, paginación y RLS con un rol no propietario.
- Worker probado con temporizadores controlados: activación explícita,
  merchant configurado, pausa con cola vacía, reintento tras errores sanitizados,
  ausencia de solapamiento y espera de la operación activa al cerrar.

La suite de DB se ejecuta por archivos en serie porque comparte un schema y M02
instala temporalmente un trigger de fallo para probar rollback; así ese trigger
no interfiere con inserciones de otros módulos. No se modificó Supabase ni Render.
Ver [alcance y pendientes de M03](m03-transactions.md).

### Validación de M03 con capturas Sandbox genuinas

El 6 de noviembre de 2026, a las 14:25 UTC, se aplicó la cuarta migración
(`20261106010000_transactions`) en el PostgreSQL Supabase del proyecto. Se inició
el build local de la rama M03 en `127.0.0.1:3001`, con el worker activado para el
merchant configurado. Render conserva M01/M02 en `main`; no se desplegó M03.

- El worker consumió los dos trabajos `TRANSACTION_CAPTURED` que estaban en cola.
  Ambos quedaron `COMPLETED`, con `finishedAt` y sin código de error.
- La captura histórica `4TD91052PF072424A` produjo la transacción
  `44c3e329-60db-496c-998a-2131625b5255`, por 1 USD ficticio, vinculada a la orden
  `5Y118346C7856021V` y al evento persistido
  `d7423e66-42c2-4b71-8d3c-b799f2267726`.
- La segunda captura `42311647XV020574X` produjo la transacción
  `3dc4f887-f710-4511-b524-4c47e1c8ee9e`, vinculada a la orden
  `8U481631H66031715` y al evento persistido
  `caef6f2e-fe37-48b9-bdd1-2e0121a9fcee`.
- Login real Supabase: HTTP 200. Listado protegido local de M03: HTTP 200,
  dos transacciones, importes como cadenas y checklist `INCOMPLETE` con pedido,
  tracking y entrega ausentes. No se utilizaron mocks en esta comprobación.

### Nuevo pago Sandbox → Render M02 → worker local M03

El usuario aprobó en Opera GX la orden Sandbox `8E96636933870233U`, por
1 USD ficticio. El checkout se preparó por API; su aprobación fue manual porque
el control del navegador falló al iniciar (`failed to write kernel assets`).
Después de comprobar el estado `APPROVED`, se capturó por la API oficial Sandbox.

- Captura HTTP 201: `7HV195624A539251X`, estado `COMPLETED`, importe `1.00 USD`.
- Webhook genuino `WH-4D3309745X8121805-54836339YA430861F`, recibido por M02
  en Render y persistido en Supabase a las `2026-11-06T14:28:28.947Z`.
- Evento local persistido: `d17c008c-bb82-4c6b-8101-fa8d6a303aae`.
- Trabajo `f550983c-d386-4466-b763-f419fb68ce0c`: `COMPLETED` a las
  `2026-11-06T14:28:29.141Z`.
- Transacción M03: `762e5e48-ed95-4093-ab83-29951fdff0d3`; una sola fila
  para la captura, con orden y referencia comercial coincidentes con la orden
  enviada a PayPal. Importe expuesto como cadena `1`, moneda `USD`.
- Listado filtrado por captura y detalle, con JWT real Supabase: HTTP 200.
  Listado: exactamente un resultado. Detalle sin sesión: HTTP 401.
- Checklist `INCOMPLETE`: pago y referencia presentes; documento de pedido,
  tracking y comprobante de entrega ausentes.

Verificación completada a las `2026-11-06T14:28:44.854Z`, sin mocks ni eventos
inyectados manualmente. Esta prueba utiliza M01/M02 publicados y el worker/API
M03 de la rama local contra Supabase compartido. No demuestra un despliegue M03
en Render, ni pedidos comerciales, M04, agentes o presentación de evidencia.

## Base común — fea0718

Ejecutada el 5 de noviembre de 2026 en Windows, Node 24.19.0 y pnpm 10.34.9.

| Comprobación                               | Resultado                                    |
| ------------------------------------------ | -------------------------------------------- |
| Generación del cliente Prisma              | Correcta                                     |
| Validación del schema                      | Correcta                                     |
| ESLint, Prettier y TypeScript estricto     | Correctos                                    |
| Pruebas unitarias y HTTP                   | 24 aprobadas                                 |
| Pruebas contra PostgreSQL real             | 2 aprobadas                                  |
| Migración inicial en DB vacía              | Aplicada                                     |
| Segunda aplicación de migraciones          | Sin cambios pendientes                       |
| Build de contratos y API                   | Correcto                                     |
| Arranque del build y HTTP health/readiness | 200, DB conectada                            |
| Arranque en desarrollo con watch           | Correcto, readiness 200                      |
| Auditoría de dependencias                  | Sin vulnerabilidades conocidas al ejecutarla |

Para la integración local se inició PostgreSQL 18.6 temporal en loopback,
fuera del repositorio; no se usó Supabase ni una base de producción.
La prueba escribe en una transacción que se revierte. Esa herramienta temporal
no es dependencia del proyecto. El CI está configurado con PostgreSQL 17.

Los casos HTTP cubren liveness, fallo de readiness, 404 uniforme, CORS permitido
y denegado, JSON inválido sin filtración de datos y documentación desactivada
por defecto en producción. Los casos de entorno comprueban puertos, URLs,
orígenes, flags, límites de iteraciones y configuración inválida sin secretos.

En esa entrega no se implementaron ni probaron PayPal/OpenAI, autenticación,
Storage o despliegue remoto.

## M01 — Merchant e integraciones

Validado localmente el 5 de noviembre de 2026, con Node 24.19.0 y PostgreSQL
18.6 temporal. Se ejecutaron las dos migraciones en una base vacía y se volvió
a ejecutar `db:deploy` sin cambios pendientes.

- `pnpm check`: schema, cliente Prisma, lint, formato, tipos, 58 pruebas y build correctos.
- `pnpm test:db`: 19 pruebas aprobadas contra PostgreSQL real.
- `pnpm audit`: ninguna vulnerabilidad conocida al ejecutarse.
- Alta CLI ejecutada dos veces: sin duplicación de membresías ni reinicio de políticas.
- JWTs con firmas ES256 y servidor JWKS local MOCK: se verifica firma, issuer,
  audience y expiración; se rechazan tokens inválidos y usuarios anónimos.
- Membresías, roles, desactivación, configuración, historial, RLS y aprobación
  obligatoria comprobados contra la base real.
- PayPal se prueba con respuestas MOCK identificadas: OAuth, lectura, acceso
  denegado, timeout, respuestas inválidas y rotación de credenciales.

### Verificación con servicios reales

Ejecutada el 5 de noviembre de 2026 (registro UTC:
`2026-11-06T04:05:13.961Z`) desde el backend compilado, con configuración local
guardada fuera de Git. Se utilizó Opera GX con las sesiones del usuario para
configurar una organización/proyecto Supabase Free y la app PayPal Sandbox
existente, habilitando Customer disputes.

| Comprobación real                                          | Resultado                                    |
| ---------------------------------------------------------- | -------------------------------------------- |
| Migraciones en PostgreSQL Supabase                         | Dos migraciones aplicadas                    |
| Conexión Prisma con session pooler y CA oficial            | Correcta, TLS verificado                     |
| JWKS de Supabase                                           | HTTP 200, ES256                              |
| Login de usuario con email y contraseña                    | HTTP 200                                     |
| Readiness del backend                                      | HTTP 200                                     |
| Acceso al merchant sin sesión                              | HTTP 401                                     |
| Acceso con JWT real y membresía ADMIN                      | HTTP 200                                     |
| OAuth PayPal Sandbox                                       | CONNECTED                                    |
| Lectura de disputas Sandbox                                | AVAILABLE, HTTP 200                          |
| Check a través de la ruta protegida y resultado persistido | Correcto                                     |
| Política de envío                                          | Deshabilitado; aprobación humana obligatoria |

La contraseña inicial del usuario se generó localmente y no se envió correo.
No se guardaron tokens de sesión en Git. No se probó presentación de evidencia,
existencia de una disputa elegible, webhooks ni despliegue remoto.
Ver [configuración de M01](m01-merchants.md).

## Integración M01 + M02 — 6 de noviembre de 2026

Se recuperó la configuración de la rama M02 desde la base actualizada y M01:
`.gitignore`, `.env.example`, configuración de formato y CI. M01 comparte OAuth
y el contexto del merchant mediante su interfaz pública. M02 agrega la ruta
de webhook, verificación oficial, persistencia y outbox transaccional.

- M01 actualizado: 61 pruebas unitarias/HTTP y 19 pruebas PostgreSQL aprobadas.
- M01 + M02: 88 pruebas unitarias/HTTP y 34 pruebas PostgreSQL aprobadas.
- Build, tipos, lint y configuración Prisma correctos.
- Tercera migración aplicada en PostgreSQL desechable y repetida sin pendientes.
- Comunicación probada por HTTP con una app Nest real: token OAuth de M01,
  contexto del merchant, verificación PayPal, respuesta y filas persistidas.
- Firmas fallidas y errores de OAuth/verificación no crean eventos ni trabajos.
- Entregas concurrentes generan un solo evento y un solo trabajo; cambios de
  contenido bajo un mismo ID se rechazan sin sobrescribir datos.
- Un trigger PostgreSQL de prueba provocó un fallo real de inserción de trabajo:
  se confirmó rollback del evento y recuperación mediante redelivery.
- RLS comprobada en las tablas de M02 usando un rol lector no propietario.
- Se corrigió la respuesta de cuerpos superiores a 1 MB: HTTP 413.

PayPal y el emisor JWKS se simulan con fixtures identificados como MOCK en estas
pruebas; PostgreSQL, Nest y la comunicación entre módulos son reales. No se ha
demostrado recepción de una entrega firmada de PayPal a un endpoint HTTPS público.
Los trabajos permanecen QUEUED hasta implementar M03/M07.

## Despliegue público — 6 de noviembre de 2026

Servicio Render Free en Virginia, código `0363df6`, con las tres migraciones
aplicadas y TLS verificado hacia Supabase. URL:
<https://resolve-ai-api-ybmj.onrender.com/api>.

- Readiness remoto: HTTP 200.
- Ruta de merchant sin sesión: HTTP 401; con JWT real de Supabase: HTTP 200,
  rol ADMIN.
- Swagger desactivado: HTTP 404.
- Check protegido PayPal desde Render: HTTP 201, `CONNECTED`, lectura de
  disputas `AVAILABLE` y `webhookConfigured: true`.
- Suscripción consultada nuevamente en la API oficial Sandbox: HTTP 200,
  URL pública correcta y los cuatro eventos de M02 registrados.
- POST público sin cabeceras PayPal: HTTP 400, `INVALID_WEBHOOK_HEADERS`.
- `pnpm check`: correcto; 88 pruebas unitarias/HTTP aprobadas. No hubo cambios
  de esquema ni de persistencia en esta fase de despliegue.

La app Sandbox devolvió una lista vacía de eventos genuinos. No se demostró
todavía entrega firmada, persistencia ni deduplicación con una entrega real
desde PayPal; esas rutas están cubiertas por las pruebas de integración con
PayPal MOCK descritas arriba. No se crearon pagos ni disputas para la prueba.
Credenciales y certificado se configuraron fuera de Git. Ver
[despliegue](deployment.md) para operación y limitaciones del plan Free.

## Pago Sandbox y entrega genuina — 6 de noviembre de 2026

Se creó una orden con las credenciales Sandbox de la app; el usuario aprobó
el checkout con la cuenta personal de prueba. Se capturó 1 USD ficticio, sin
utilizar el entorno Live.

- Orden: `5Y118346C7856021V`, estado `COMPLETED`.
- Captura: `4TD91052PF072424A`, HTTP 201, estado `COMPLETED`.
- Evento genuino: `WH-1YS32612YL8319623-7XB699471K872161N`,
  `PAYMENT.CAPTURE.COMPLETED`.
- Evento persistido: `d7423e66-42c2-4b71-8d3c-b799f2267726`, recibido a las
  `2026-11-06T07:49:09.408Z`.
- Trabajo: `f9699d90-ecdc-48e9-a4c9-54e053e02f46`, tipo
  `TRANSACTION_CAPTURED`, estado `QUEUED`.

La primera entrega recibió HTTP 401. Se detectó que la validación Zod
reconstruía el envelope en el orden de campos del schema antes del postback
de firma. Se corrigió conservando el objeto original después de validarlo,
sin relajar la verificación de PayPal. Tras desplegar `34e908b` y solicitar
el reenvío, el mismo evento superó la verificación y se guardó con su trabajo.
Se solicitó un segundo envío del mismo evento: PayPal confirmó `SUCCESS`,
HTTP 200, transmisión `9e320748-d9b6-11f1-9e97-6d78f882e18a` a las
`2026-11-06T07:49:38Z`. PostgreSQL conservó un único evento y un único trabajo,
con el registro original intacto; la deduplicación también quedó comprobada.
La corrección incluye una prueba de regresión: 89 pruebas unitarias/HTTP
y las 34 pruebas PostgreSQL aprobaron CI.

Esto verifica el flujo de captura entre M01, M02, PayPal, Render y Supabase.
No verifica eventos genuinos de disputas ni consumidores de M03/M07; el
trabajo permanece en la outbox hasta implementar esos módulos.
