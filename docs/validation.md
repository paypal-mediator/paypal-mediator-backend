# Validaciones del backend

## M05 local: NVIDIA real y OpenAI intercambiable — 6 de noviembre de 2026

- `pnpm check`: **157 pruebas unitarias/HTTP**, tipos, lint, formato, Prisma y
  build aprobados. `pnpm test:db`: **79 pruebas PostgreSQL aprobadas**. Se
  aplicaron ocho migraciones desde cero, se reaplicaron sin pendientes y
  `prisma migrate diff` no detectó diferencias. La octava se aplicó también en
  Supabase para la prueba externa del módulo local.
- Una llamada de conectividad DEMO al endpoint NVIDIA respondió HTTP 200 con
  `nvidia/nemotron-3.5-super-vl-120b-a12b`. No se hizo una llamada real a OpenAI;
  su adaptador Responses, schema estricto y ausencia de fallback se probaron con MOCK.
- Investigación local con Supabase Auth/PostgreSQL/Storage y NVIDIA reales:
  `cdfe803a-acff-4a88-ab44-4fcca99fc4d3`, estado COMPLETED, prompt `m05-inr-v1.1`,
  seis pasos, 27130 tokens de entrada y 1378 de salida. Leyó pago, pedido,
  tracking, entrega y la foto original del usuario; clasificó esta última como
  apuntes de matemáticas sin relevancia para una entrega.
- La repetición con la misma clave devolvió el mismo resultado/uso sin otra
  investigación; sin JWT HTTP 401. Se activó temporalmente el permiso de
  investigación mediante M01 y se restauró después. No se habilitaron envíos.
- El borrador conserva IDs citados y `requiresVerification=true`. Los registros
  comerciales/envío son DEMO; no existe fuente comercial conectada. El resumen
  del modelo todavía mezcla etiquetas de procedencia y marca READY/DEMO como
  contradicción: son errores semánticos observados, no se corrigió la salida
  para simular una respuesta perfecta. M06 sigue siendo necesario.
- M05 aún no está desplegado en Render. El circuito de disputas M07 y la
  presentación M08 no se ejecutaron. PDF se conserva, pero M05 declara que su
  contenido no fue analizado; imágenes PNG/JPEG sí se pueden inspeccionar.

Ver [contrato y límites M05](m05-investigator.md) y
[salida original de la prueba real](evidence/m05-nvidia-live-20261106.json).

## M04: archivo existente del usuario y Storage real — 6 de noviembre de 2026

Se eligió, con autorización del usuario, una foto de apuntes de matemáticas
existente en Descargas: `WhatsApp Image 2026-11-05 at 5.41.42 PM.jpeg`,
**83.183 bytes**. No se generó, rotó, convirtió ni reemplazó su contenido.
Se adjuntó a la transacción `c749a5d6-bd30-42e6-bfc0-f81c4c38cf6a`, correspondiente
al pago Sandbox ya capturado `0R443662EP786444T`. Es una prueba de almacenamiento,
no una prueba comercial de envío.

- Bucket `private-evidence` en Supabase, `public=false`, límite de 524288 bytes,
  MIME PDF/PNG/JPEG. `pnpm storage:setup` lo creó; repetir devolvió `created=false`.
- Credencial de servidor existente configurada fuera de Git. Se verificó el
  uso de la clave actual en `apikey`, sin tratarla como un JWT Bearer.
- Se aplicaron en Supabase las migraciones sexta y séptima. La prueba real
  detectó una restricción previa `evidence_items_provenance_type_check` que
  excluía DOCUMENT; la séptima migración la extiende conservando el control de
  procedencia y se instala también en bases nuevas.
- API NestJS local con Supabase Auth/PostgreSQL/Storage reales: carga HTTP 201,
  evidencia `9c04f004-93e7-404f-9a80-2747484919ed`, versión 7. Repetir devolvió
  `DUPLICATE` con el mismo ID. Descarga HTTP 200; sin sesión HTTP 401.
- Original local, objeto descargado directamente de Storage y descarga por M04
  tienen SHA-256 `8d9dcb9bb03fb86b5479aa7a2bb517edb68fa81c927eab705761291936bb1a30`.
  Se comprobó además igualdad byte a byte. Acceso por URL pública: HTTP 400,
  sin exposición del objeto privado.
- Se guardó la respuesta binaria de M04 en `Downloads/ResolveAI-M04-recuperados`
  y se abrió esa imagen en Opera GX, no un informe ni un documento sustituto.

Resultados técnicos sin credenciales ni bytes del usuario:
[prueba real de Storage](evidence/m04-real-storage-20261106.json).
La foto no se añade al repositorio.

Validación de código: `pnpm check` aprobado con **148 pruebas unitarias/HTTP**;
`pnpm test:db` aprobado con **64 pruebas** en PostgreSQL desechable. Las siete
migraciones se aplicaron desde cero y se repitieron sin pendientes. La clave y
bucket se configuraron también en Render, guardando sin desplegar código antiguo.

### Verificación posterior en Render

PR [#11](https://github.com/paypal-mediator/paypal-mediator-backend/pull/11)
integrado en `main` por `f49fd6c`. CI de rama, PR y main aprobado; la ejecución
de main fue `42277495503`. Render publicó ese commit con estado Live y duración
de despliegue de 1m 8s. La prueba HTTP terminó a las **2026-11-06T19:14:36.760Z**.

Se volvió a cargar la misma foto mediante la API publicada: HTTP 201 con
`DUPLICATE`, conservando el ID y la revisión 7. Descarga por Render HTTP 200;
sin sesión HTTP 401. El original, el objeto de Supabase y la descarga desde
Render mantuvieron el SHA-256 e igualdad byte a byte indicados arriba. URL
pública de Storage HTTP 400. No intervino ningún backend local en esta fase.

La respuesta binaria de Render se guardó en `Downloads/ResolveAI-M04-Render`
con el nombre original. Se mostró además el objeto en la vista previa de
Supabase Storage. No se muestra un documento generado como si fuera evidencia.
Resultados: [verificación de Render/Storage real](evidence/m04-real-storage-render-20261106.json).

## Nuevo pago Sandbox aprobado en Opera GX — 6 de noviembre de 2026

Prueba ejecutada contra Render/Supabase y PayPal Sandbox. Se abrió Opera GX
mediante su canal local CDP, expresamente autorizado por el usuario, que inició
sesión y aprobó el checkout con su comprador Sandbox. Se consultó la orden y se
confirmó `APPROVED` antes de capturar por la API oficial; captura HTTP 201,
`COMPLETED`, **1 USD ficticio**. No se añadieron funciones de cobro al producto.

| Dato            | Resultado                                          |
| --------------- | -------------------------------------------------- |
| Orden PayPal    | `8YN46316PH6397206`                                |
| Captura         | `0R443662EP786444T`                                |
| Transacción M03 | `c749a5d6-bd30-42e6-bfc0-f81c4c38cf6a`             |
| Expediente M04  | `d40624b3-1701-448b-9663-1b8414cfa7e0`, revisión 6 |

- **M01:** login Supabase, readiness y merchant ADMIN HTTP 200; check PayPal
  HTTP 201, OAuth `CONNECTED` y disputas `AVAILABLE`. Aprobación humana
  obligatoria y presentación de evidencia deshabilitada.
- **M02:** webhook genuino `PAYMENT.CAPTURE.COMPLETED` persistido y trabajo
  `COMPLETED`. Se verificaron las filas de evento/trabajo en PostgreSQL; el
  consumidor fue el worker publicado en Render, sin worker local.
- **M03:** pedido DEMO registrado y vinculado a la nueva captura; detalle HTTP 200. La preparación inicial fue `INCOMPLETE`.
- **M04 estructurado:** tracking y entrega DEMO produjeron `READY`; duplicar
  entrega devolvió `DUPLICATE` con el mismo ID. Tracking contradictorio produjo
  `NEEDS_REVIEW`; corregirlo restauró `READY`. El expediente conserva seis
  versiones con integridad JSON válida y `containsDemo=true`. Consulta del
  expediente sin sesión: HTTP 401.

El pago, autenticación, webhook y persistencia son servicios Sandbox reales.
Pedido, carrier y entrega son **DEMO**, no documentos autenticados de un carrier.
`READY` indica cobertura documental, no permiso de envío. No se enviaron
evidencias a PayPal. **No se probó el incremento de archivos binarios/Storage**:
faltan sus credenciales locales y el incremento no está desplegado en Render.

Resultados sin credenciales y expediente completo:
[evidencia de esta ejecución](evidence/m01-m04-sandbox-20261106.json).

## Incremento local M04: archivos originales — 6 de noviembre de 2026

- `pnpm check`: generación/validación Prisma, lint, formato, tipos, **142 pruebas
  unitarias/HTTP** y build aprobados.
- `pnpm test:db`: **64 pruebas PostgreSQL aprobadas**. La ampliación comprueba
  carga/descarga HTTP, roles ADMIN/VIEWER, aislamiento por merchant y transacción,
  versiones y duplicados, preservación de originales anteriores, límites/formato,
  procedencia inmutable y rechazo de versiones antiguas antes de escribir Storage.
- Se comprobaron hashes binarios alterados, metadatos corruptos, `NEEDS_REVIEW`
  y rollback de item/revisión al fallar Storage. Un adjunto no completa por sí
  solo la cobertura de tracking/entrega.
- Adaptador Storage con **MOCK explícito**: bucket público rechazado, ausencia de
  credenciales, errores sanitizados, cargas sin overwrite, lectura autenticada,
  duplicados verificados y límite de bytes descargados.
- Se aplicaron las seis migraciones en PostgreSQL desechable de loopback,
  incluida `20261106030000_evidence_documents`. Segunda aplicación sin pendientes;
  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`:
  sin diferencias.
- No se modificaron Supabase ni Render. Storage y JWKS son MOCK; los bytes de
  documento son fixtures DEMO, no documentos comerciales auténticos. Quedan
  pendientes aprovisionamiento/verificación de Storage real, despliegue y
  conectores comerciales. Ver [contrato y configuración M04](m04-evidence.md).

## Prueba completa M01–M03 en Render con base M04 — 6 de noviembre de 2026

Ampliación integrada por PR #8 (`5dfae91`, implementación `bd8857c`). CI del PR
y de `main` `42241302830` aprobado: 124 pruebas unitarias/HTTP, 63 PostgreSQL,
Prisma, lint, formato, tipos, build y migraciones repetibles. Render aplicó la
quinta migración en Supabase y publicó el consumidor actualizado.

Prueba autorizada por el usuario, íntegramente contra Render/Supabase y PayPal
Sandbox, sin consumidor local. Se preparó el checkout por API y el usuario aprobó
el pago con su comprador de pruebas. La captura se ejecutó después de publicar
las rutas nuevas y registrar el pedido DEMO.

| Dato                  | Identificador / resultado                                      |
| --------------------- | -------------------------------------------------------------- |
| Orden PayPal          | `1BY117808X500542F`                                            |
| Captura               | `2D098449XH6131418`, HTTP 201, `COMPLETED`, 1 USD ficticio     |
| Pedido comercial DEMO | `3238f3db-6eb7-437e-af35-71a391fb1a19`                         |
| Evento PayPal genuino | `WH-1UC87426W66536315-7UH97843UM042004A`                       |
| Evento persistido M02 | `bab0154e-f6b8-4c5b-a0d0-972df010c20f`                         |
| Trabajo               | `81b31a1d-55a0-4c29-bde6-f2301cc131d8`, `COMPLETED`, sin error |
| Transacción M03       | `933cc99f-4926-46a4-9bf9-a41a6c914941`                         |
| Expediente M04        | `dda534d0-07c5-4bc6-bb8c-7a3c57ffb23e`, revisión 8             |

### Comprobaciones reales

- **M01:** login Supabase y merchant ADMIN HTTP 200; acceso sin sesión HTTP 401.
  Check protegido HTTP 201, OAuth `CONNECTED`, lectura de disputas `AVAILABLE`,
  webhook configurado y aprobación humana obligatoria. No se habilitaron envíos.
- **M02:** webhook sin cabeceras de firma rechazado con HTTP 400 y cero filas para
  ese control DEMO. Evento genuino recibido a las `2026-11-06T15:18:18.352Z`,
  trabajo completado a las `2026-11-06T15:18:19.480Z`. La API oficial de PayPal
  confirmó HTTP 200 el ID de evento y su captura correspondiente.
- **M03:** pedido registrado HTTP 201, repetición `DUPLICATE` y cambio de contenido
  HTTP 409. El worker en Render creó una sola transacción, vinculada al pedido
  por referencias e importe coincidentes. Listado y detalle HTTP 200.
- **Base M04:** expediente inicial con pago/pedido, tracking DEMO y entrega DEMO
  persistidos; `INCOMPLETE → READY`. Repetir la misma entrega conservó ID/revisión.
  Evidencia para otra orden fue rechazada con HTTP 409.
- Tracking contradictorio produjo `NEEDS_REVIEW/TRACKING_CONTRADICTION`; una
  corrección restauró `READY`. Retractar la entrega produjo
  `INCOMPLETE/DELIVERY_RETRACTED`; una nueva versión coherente restauró `READY`.
- El expediente terminó con ocho versiones, cuatro registros vigentes, todos con
  integridad válida y `containsDemo=true`. El historial conserva contradicción,
  correcciones y retractación. Lectura de expediente sin sesión: HTTP 401.

La comprobación funcional terminó a las `2026-11-06T15:18:22.277Z`. Después se
solicitó un reenvío oficial del mismo webhook: HTTP 202. A las
`2026-11-06T15:20:12.472Z` se conservaban un evento, un job, una transacción y un
expediente, sin incrementar su revisión. La API de eventos no expuso confirmaciones
de transmisión: **no se afirma HTTP 200 de esa segunda entrega**.
El primer intento de preflight tuvo timeout de transporte; el reintento pasó.

El pago, firma, autorización y persistencia utilizaron servicios Sandbox reales.
Los datos de pedido/envío/entrega se aportaron como **DEMO**, no mediante un carrier
real; `READY` describe cobertura documental. No se enviaron evidencias a PayPal
ni se probaron archivos o Storage.

Evidencia sin credenciales: [resultados de la prueba](evidence/m01-m03-full-sandbox.json)
y [expediente JSON devuelto por M04](evidence/m04-full-sandbox-dossier.json).
El segundo archivo es la respuesta del módulo, no un informe visual generado.

## Ampliación local M03: órdenes y base M04 — 6 de noviembre de 2026

- `pnpm check`: generación/validación Prisma, lint, formato, tipos, **124 pruebas
  unitarias/HTTP** y build aprobados.
- `pnpm test:db`: **63 pruebas PostgreSQL aprobadas**, incluidas 20 de órdenes y
  expedientes; app NestJS/HTTP, persistencia y comunicación entre módulos reales.
- Quinta migración `20261106020000_orders_evidence` aplicada en PostgreSQL 18.6
  desechable en loopback. Segunda aplicación sin pendientes; `prisma migrate diff`
  entre la base y el schema: sin diferencias.
- Se verificaron pedidos anteriores/posteriores al pago y concurrentes,
  idempotencia, validación decimal exacta, rechazo de conflictos y roles,
  estado READY con datos persistidos, versiones/retractaciones, actualización
  antigua rechazada, contradicciones de tracking/fechas, hashes alterados,
  inicialización de capturas antiguas y rollback conjunto M02–M03–M04.
- RLS comprobada con un rol no propietario y claves foráneas aisladas por merchant.
- Los pedidos y envíos de prueba son DEMO / MOCK, identificados como tales;
  JWT/JWKS son MOCK. No se consultaron carriers ni se utilizaron documentos reales.

Esta fase no modifica Supabase/Render y no verifica Storage privado o archivos.
La evidencia visual anterior conserva su fecha y alcance; no se presenta como
evidencia producida automáticamente por M03 ni como prueba de esta ampliación.

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

Archivos de evidencia: [informe visual PNG](evidence/m03-render-evidence.png) y
[resultados registrados JSON](evidence/m03-render-evidence.json).

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

# Fuentes de pedidos: prueba real Sandbox, 6 de noviembre de 2026

- Orden `5AA87137A4512751T`, captura `9L5781332K437132K`: HTTP 201,
  `COMPLETED`, 1 USD ficticio, aprobada por el usuario en Opera GX controlado por CDP local.
- M01: Auth Supabase real, ADMIN HTTP 200; OAuth PayPal conectado HTTP 201.
- M02 en Render: evento genuino `WH-21J09557NM515442T-05V02304MT7334107`,
  firma verificada, trabajo `COMPLETED`.
- M03/M04 nuevos ejecutados localmente contra Supabase real **antes del commit**;
  worker publicado temporalmente pausado para evitar competencia.
  Transacción `949523cc-d4f3-4fba-9c4d-e3aecaa4a687`, sin `merchantOrderId`
  y sin `POST /orders`: fuente `PAYPAL`, asociación `LINKED`, enriquecimiento `COMPLETE`.
- Dos artículos reales del checkout de prueba: SKU SANDBOX-A, cantidad 2,
  unitario USD `0.30`; SANDBOX-B, cantidad 1, unitario USD `0.20`.
  Item total `0.80`, envío `0.10`, impuestos `0.10`; los otros ceros fueron
  enviados explícitamente en el checkout y devueltos por PayPal.
- M04: `PAYMENT_RECORD`, `ORDER_SOURCE_RECORD` con JSON original PayPal y
  `ORDER_RECORD`, los tres con integridad `VALID`. Refresh HTTP 201 sin aumentar
  revisión 3. Sin sesión HTTP 401. Readiness `INCOMPLETE`: no se fabricó tracking
  ni entrega. No se enviaron evidencias a PayPal.
- `pnpm check`: 168 pruebas unitarias/HTTP. `pnpm test:db`: 72 pruebas en
  PostgreSQL desechable; PayPal/JWKS/ERP son MOCK en esas suites. Migración
  aplicada, repetida sin pendientes y sin diferencias de schema; aplicada también
  en Supabase. Los originales JSON están en M04 privado; no se guardan respuestas
  con datos personales completos ni credenciales en Git.

Evidencia técnica sanitizada: [JSON](evidence/order-sources-sandbox-20261106.json).
Contrato y limitaciones: [fuentes](order-information-sources.md).

### Confirmación publicada

PR #15 integrado en `main` (`728eb59`), CI aprobado y Render `Live`.
Se restauró `TRANSACTION_WORKER_ENABLED=true` y se detuvo el worker local.
La misma transacción se leyó desde Render con sus dos artículos; refresh
consultó PayPal y mantuvo revisión 3. Sin sesión HTTP 401.
Ver [verificación publicada](evidence/order-sources-render-20261106.json).

Backfill real de `8YN46316PH6397206`: PayPal no proporcionó artículos ni
breakdowns, por lo que devuelve `PARTIAL`, `items: []` y envío `null`.
El pedido DEMO anterior conserva su ID y procedencia; PayPal se agrega como fuente
independiente. El `READY` de ese expediente anterior procede de su cobertura
DEMO de tracking/entrega y no convierte esos datos en información verificada.
Ver [backfill publicado](evidence/order-sources-backfill-20261106.json).

Regresión Storage de solo lectura desde Render: el JPEG existente del usuario
se descargó con HTTP 200, 83.183 bytes e idéntico SHA-256 al archivo original;
sin sesión HTTP 401. No se generó sustituto ni se adjuntó esa foto como prueba
de envío a la nueva compra. Ver [resultado](evidence/order-sources-storage-regression-20261106.json).

## Recorrido real M01–M06 — 7 de noviembre de 2026

Orden `41C54140SD9188621`, captura `9MX67512MD686194C`, 1 USD ficticio. El usuario
aprobó el checkout Sandbox en Opera GX: el controlador de ventanas no estuvo
disponible y no hubo navegador conectado. La captura devolvió HTTP 201/COMPLETED.
No se utilizó Live ni se presentó evidencia de disputa.

- M01: login Supabase real, ADMIN HTTP 200, sin sesión 401; OAuth CONNECTED y
  lectura de disputas AVAILABLE. Readiness local y Render HTTP 200.
- M02: webhook genuino `WH-5GK32453EX0443533-1P325080EG777670J`, verificado en
  Render y persistido; trabajo TRANSACTION_CAPTURED COMPLETED.
- M03: transacción `b62b4f9e-2f1b-4daf-a1f4-63e9e6cf6b9a`, pedido LINKED y dos
  artículos recuperados de PayPal; sin pedido manual ni tracking DEMO.
- M04: originales PAYMENT_RECORD, ORDER_SOURCE_RECORD y ORDER_RECORD con
  integridad VALID; revisión 3 estable tras refresh. Descarga de un JPEG previo
  de Storage privado: HTTP 200, 83.183 bytes y SHA-256 idéntico; sin sesión 401.
  Ese archivo no se adjuntó a la compra nueva ni se compartió con los agentes.
- M05: NVIDIA real, COMPLETED, sources AVAILABLE, requiresVerification=true;
  repetición de clave devolvió el mismo ID sin otra inferencia.
- M06: NVIDIA real con contexto y lecturas propios, nueve unidades del borrador
  evaluadas y ocho dimensiones presentes. Resultado final INCOMPLETE: cobertura
  FAIL por faltantes de tracking/entrega; las otras siete dimensiones PASS.
  submissionAuthorized=false. Repetir la clave conserva el resultado.

La prueba descubrió y corrigió dos fallos: NVIDIA devolvía evidenceIds fuera de
los hallazgos (se activó response_format json_schema estricto) y M06 comparaba
custom_id comercial con el ID de orden PayPal (se limitó esa comparación a
tracking/entrega). Los FAILED y el primer REJECTED permanecen en el historial.
Un reintento sin revisión tras REJECTED devolvió 409. Antes de repetir M06 el
usuario autorizó explícitamente una revisión, registrada con actor, fecha y motivo.
El prompt v2.1 recibe verificationAsOf y distingue vigencia de cobertura.

M05/M06 se ejecutaron en el backend local actual contra Supabase real; el webhook
público sigue en Render. No implica despliegue de esos módulos. Se restauró
allowInvestigations=false; allowSubmissions=false y aprobación humana obligatoria.
No se demostró APPROVED con entrega real: esos escenarios siguen siendo MOCK.

Validación automatizada: 189 pruebas unitarias/HTTP y 88 PostgreSQL aprobadas;
diez migraciones aplicadas y repetidas en PostgreSQL desechable, diff sin cambios.
La migración M06 también se aplicó en Supabase. Tipos, ESLint, build y formato de
archivos versionados aprobados. pnpm check se detuvo en format:check por el
Implementation.md preexistente sin seguimiento; no se modificó ese archivo.
Los mocks de las suites se distinguen del recorrido externo real anterior.

Evidencia sanitizada: [M01–M06](evidence/m01-m06-sandbox-20261107.json).
