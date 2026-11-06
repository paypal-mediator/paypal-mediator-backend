# Validaciones del backend

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
