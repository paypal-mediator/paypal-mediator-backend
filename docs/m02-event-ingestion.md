# M02 — Ingesta de webhooks PayPal

`POST /api/webhooks/paypal` recibe entregas de PayPal Sandbox. La ruta no usa
el JWT del merchant: autentica cada evento mediante la API oficial de
verificación de firmas de PayPal. Solo devuelve HTTP 200 cuando el evento y,
si corresponde, su trabajo pendiente se han confirmado en PostgreSQL.

## Comunicación con M01

M02 importa únicamente la interfaz pública de `MerchantsModule`:

1. `MerchantsService.getPayPalWebhookContext()` comprueba que exista el merchant
   configurado y obtiene su ID y `PAYPAL_WEBHOOK_ID` desde el servidor.
2. `PayPalAuthService.getAccessToken()` obtiene OAuth utilizando las credenciales
   Sandbox de M01. El token no se devuelve al remitente ni se persiste.
3. M02 envía las cinco cabeceras de transmisión, el webhook ID configurado y el
   evento completo a `POST /v1/notifications/verify-webhook-signature`.
4. Solo `verification_status=SUCCESS` permite persistir. Un resultado FAILURE
   devuelve 401; errores de OAuth, red, timeout o respuesta inválida devuelven
   503 para permitir reintento. El timeout limita el conjunto de llamadas.

No se acepta un merchant ni un webhook ID elegidos por el payload. La ingesta
no cambia las políticas ni las tablas privadas de M01 y no activa investigación
o presentación de evidencia. Las rutas del merchant conservan su JWT y roles.

## Contrato HTTP

Cabeceras obligatorias:

- `paypal-transmission-id`
- `paypal-transmission-time`
- `paypal-transmission-sig`
- `paypal-cert-url`
- `paypal-auth-algo` (`SHA256withRSA`)

El cuerpo debe ser JSON con `id`, `event_type`, `create_time` y `resource`.
Los campos adicionales se conservan para la verificación y el expediente.
Se limita el cuerpo a 1 MB y la profundidad admitida. Solo se aceptan URLs de
certificados HTTPS de hosts PayPal conocidos; el backend no descarga esas URLs.
La única URL externa que invoca el verificador es el host Sandbox fijo.

Respuesta de ejemplo **DEMO / MOCK**:

```json
{
  "eventId": "7bf43c03-5675-45c5-8231-c94746d1e072",
  "paypalEventId": "MOCK-EVENT-1",
  "outcome": "ACCEPTED",
  "jobId": "7a9ac9dc-f276-4284-b44c-7b69eabeb79c"
}
```

`ACCEPTED` indica un evento con trabajo persistido; `DUPLICATE` devuelve las
mismas referencias sin crear otro trabajo; `IGNORED` indica un tipo no soportado
verificado y guardado, con `jobId=null`. Ninguno significa procesamiento de
una transacción, investigación o resolución de una disputa.

| Tipo PayPal                 | Trabajo pendiente      | Consumidor futuro |
| --------------------------- | ---------------------- | ----------------- |
| `PAYMENT.CAPTURE.COMPLETED` | `TRANSACTION_CAPTURED` | M03               |
| `CUSTOMER.DISPUTE.CREATED`  | `DISPUTE_CHANGED`      | M07               |
| `CUSTOMER.DISPUTE.UPDATED`  | `DISPUTE_CHANGED`      | M07               |
| `CUSTOMER.DISPUTE.RESOLVED` | `DISPUTE_CHANGED`      | M07               |

## Persistencia e idempotencia

M02 es propietario de `WebhookEvent` e `IngestionJob`. Se guardan el JSON
completo, cuerpo original, hashes de integridad, identificadores de PayPal,
merchant y fecha. Una transacción inserta el evento y su trabajo `QUEUED`.
Si falla la creación del trabajo, se revierte también el evento y se responde
sin éxito, de modo que una nueva entrega pueda recuperarlo.

La clave única `(merchantId, environment, paypalEventId)` resuelve también
entregas concurrentes. Los duplicados se verifican de nuevo antes de
confirmarlos. Se compara un hash canónico que tolera cambios de espacios y
orden de claves; si el mismo ID contiene datos diferentes se responde 409 sin
sobrescribir el original. El hash de bytes original se conserva por separado.
RLS sin políticas públicas protege ambas tablas frente a clientes Supabase.
No se registran cuerpos, tokens, firmas ni credenciales en logs.

La cola es una outbox persistida en PostgreSQL, sin Redis ni proceso en memoria.
La interfaz pública `IngestionQueueService` permite consumir trabajos con locks
y una transacción compartida. M03 consume `TRANSACTION_CAPTURED` y confirma el
trabajo junto con la captura; registra rechazos terminales como `FAILED` y revierte
errores inesperados para permitir reintentos. M07 consume `DISPUTE_CHANGED`
con la misma interfaz, escribe solo sus tablas y no presenta evidencia. Ver
[M03](m03-transactions.md) y [M07](m07-disputes.md).

## Configuración y límites de prueba

Aplicar `pnpm db:deploy`. M01 debe tener merchant provisionado,
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y el `PAYPAL_WEBHOOK_ID` de la app
Sandbox. Sin esa configuración el webhook falla cerrado.

Registrar una URL pública HTTPS real terminada en `/api/webhooks/paypal` y
suscribir los cuatro eventos de la tabla. No registrar localhost ni un dominio
ficticio. La API está publicada en Render y se verificaron entregas firmadas
genuinas de PayPal Sandbox; ver [validación](validation.md). Las suites
automatizadas usan cabeceras y
respuestas de PayPal **MOCK**, sin añadir un bypass de firma en producción.

`pnpm test` cubre validaciones, firma, errores y HTTP. `pnpm test:db` cubre la
comunicación real entre módulos, OAuth de M01 con transporte PayPal MOCK,
persistencia, concurrencia, rollback de la cola, permisos de M01 y RLS sobre
PostgreSQL real. Nunca ejecutar estas pruebas contra la base del demo.

Referencias oficiales:
[integración y verificación](https://developer.paypal.com/api/rest/webhooks/rest/),
[reintentos de entrega](https://developer.paypal.com/api/rest/webhooks/).
