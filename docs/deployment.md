# Backend público y webhook PayPal

## Servicio del proyecto

- API: <https://resolve-ai-api-ybmj.onrender.com/api>.
- Readiness: <https://resolve-ai-api-ybmj.onrender.com/api/health/ready>.
- Webhook Sandbox: <https://resolve-ai-api-ybmj.onrender.com/api/webhooks/paypal>
  (solo POST; abrirlo en el navegador no genera una entrega).
- Render: `resolve-ai-api`, plan Free, Virginia, rama `main`.

M03 está publicado desde PR #6 (`ff12287`, implementación `6c3302c`). Verificado
el 6 de noviembre de 2026 a las 14:40 UTC: readiness HTTP 200, listado filtrado
y detalle de la captura `7HV195624A539251X` HTTP 200 con JWT real Supabase;
acceso sin sesión HTTP 401. El worker local temporal se detuvo antes de verificar
las rutas públicas. Hay cuatro migraciones aplicadas en Supabase. El worker de
capturas está habilitado por defecto en producción; ver la variable descrita abajo.

El 6 de noviembre de 2026 se publicó el servicio y se registró la suscripción
en la app PayPal Sandbox con los cuatro eventos descritos abajo. Se verificaron
readiness y acceso ADMIN con un JWT real de Supabase, además de OAuth y lectura
de disputas de PayPal desde Render. Después se capturó un pago Sandbox de
1 USD ficticio: su evento firmado se verificó y persistió en Supabase junto
con un trabajo `TRANSACTION_CAPTURED` en estado `QUEUED`. Ver los identificadores
y el alcance de la prueba en [validación](validation.md).

## Configuración

Render publica el backend NestJS como Web Service con HTTPS. `render.yaml`
describe un servicio Free en Virginia; usa Node 24, el lockfile pnpm y el
build de contratos/API. `npm run start:render` aplica migraciones existentes y
arranca el código compilado. El backend escucha en `0.0.0.0` y utiliza `PORT`
proporcionado por Render. Swagger se desactiva en el entorno publicado.

## Variables y certificado

Configurar en Render únicamente las variables requeridas por el servicio,
sin subir `.env`, contraseñas de usuarios ni credenciales de aprovisionamiento.
Las variables secretas del Blueprint usan `sync: false`.

- `DATABASE_URL` y `DIRECT_URL`: session pooler de Supabase con TLS verificado.
- `SUPABASE_URL`, `MERCHANT_ID`: el proyecto y merchant ya provisionados.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: app Sandbox del merchant.
- `PAYPAL_WEBHOOK_ID`: ID de la suscripción real registrada para este endpoint.
  Puede permanecer vacío durante el primer despliegue; la ingesta falla cerrada.
- `CORS_ORIGIN`: origen del frontend; para desarrollo puede ser
  `http://localhost:3000`, aunque la API esté publicada.
- `TRANSACTION_WORKER_ENABLED=true`: consumidor M03 de capturas verificadas.
  El código lo habilita por defecto en producción cuando la variable no está
  definida; un `false` explícito lo desactiva. Requiere `MERCHANT_ID` y las cuatro
  migraciones aplicadas. Las disputas permanecen en cola para M07.

Agregar en Environment → Secret Files el certificado oficial de Supabase con
nombre `supabase-ca.crt`. En las URLs de PostgreSQL reemplazar la ruta local
de `sslrootcert` por `/etc/secrets/supabase-ca.crt` y conservar
`sslmode=verify-full`. Las rutas Windows del `.env` local no sirven en Render.
Los valores y certificados se configuran en el Dashboard, no en el repositorio.

El plan Free no dispone de pre-deploy command; las migraciones se ejecutan al
arrancar, con las dependencias de desarrollo instaladas para disponer de Prisma
CLI. Si una migración falla no se inicia la API. Al crecer a varias instancias,
trasladar migraciones a una fase de release independiente.

## Registro PayPal

1. Confirmar HTTP 200 en `/api/health/ready` de la URL asignada por Render.
2. Registrar `https://<servicio>.onrender.com/api/webhooks/paypal` en la misma app
   PayPal Sandbox del merchant.
3. Suscribir `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`,
   `CUSTOMER.DISPUTE.UPDATED` y `CUSTOMER.DISPUTE.RESOLVED`.
4. Guardar el ID de la suscripción en `PAYPAL_WEBHOOK_ID` en Render y localmente,
   y reiniciar/desplegar para aplicar el cambio.
5. Comprobar una entrega real en PayPal y las filas `WebhookEvent`/`IngestionJob`.

El simulador de PayPal genera eventos MOCK que no son equivalentes a una
entrega real y no admiten la verificación de firma postback usada por M02.
No desactivar la firma para conseguir una respuesta exitosa del simulador.
Una entrega real puede proceder de una operación Sandbox o del reenvío de un
evento genuino existente de esa app; nunca presentar un fixture como real.

El plan Free puede suspender el proceso por inactividad. PayPal reintenta
entregas sin respuesta exitosa, pero una demo con disponibilidad continua puede
necesitar un plan de pago elegido expresamente por el equipo.

Referencias: [Render Web Services](https://render.com/docs/web-services),
[secret files](https://render.com/docs/configure-environment-variables),
[simulador PayPal](https://developer.paypal.com/api/rest/webhooks/simulator/).
