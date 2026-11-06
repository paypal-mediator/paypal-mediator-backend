# M03 — Transaction Manager, primer incremento

Capturas persistidas y consulta por merchant dentro del backend NestJS.
No crea pagos, disputas ni documentos comerciales. No hace llamadas nuevas a
PayPal: consume exclusivamente eventos que M02 ya verificó y persistió.

## Consumo y persistencia

`TransactionsService.processNextCapture(merchantId)` utiliza la interfaz pública
`IngestionQueueService` de M02. M02 conserva la propiedad de sus eventos y trabajos;
el consumidor escribe únicamente `transactions` usando la transacción recibida.
La captura y el estado `COMPLETED` del trabajo se confirman juntos.

El consumidor valida `PAYMENT.CAPTURE.COMPLETED`, `resource.status=COMPLETED`,
importe positivo expresado como cadena decimal, moneda y fecha de captura.
Los importes se guardan como `DECIMAL(24,8)` y se exponen como cadenas, sin
conversiones a números de punto flotante. La respuesta puede normalizar ceros
finales (`1.00` → `1`). No se calculan importes ni se infiere moneda.

Se conservan `resource.id`, `supplementary_data.related_ids.order_id`, `custom_id`
e `invoice_id` cuando existen. Un ID de orden PayPal o una referencia comercial
no constituye un documento de pedido. El formato de referencias se contrastó con
[PayPal Payments v2](https://developer.paypal.com/api/payments/v2/definitions/supplementary_data/).

Hay unicidad por merchant, entorno y captura. `FOR UPDATE SKIP LOCKED` evita
tomar el mismo trabajo simultáneamente y un advisory lock transaccional serializa
eventos diferentes para la misma captura. Un duplicado equivalente completa el
trabajo sin crear otra transacción. Un cambio en importe, moneda, fecha o
referencias deja `FAILED/CAPTURE_CONFLICT`, sin sobrescribir el original.
Los datos inválidos dejan `FAILED/INVALID_CAPTURE`. Se guardan fecha de finalización
y código de error, nunca cuerpos ni errores externos en logs.

Un savepoint revierte las escrituras del consumidor ante un rechazo esperado;
los errores inesperados revierten toda la transacción y dejan el trabajo `QUEUED`
para reintento. Los fallos terminales requieren revisión; este incremento no
ofrece una ruta para reencolarlos. No hay límite persistente de intentos para
fallos inesperados; se reintentan con pausa fija de cinco segundos.

## Worker

Configurar `TRANSACTION_WORKER_ENABLED=true` y `MERCHANT_ID` para consumir
automáticamente capturas del merchant configurado, incluidas las ya en cola.
Por defecto está habilitado en producción y deshabilitado en desarrollo/pruebas;
un `TRANSACTION_WORKER_ENABLED=false` explícito lo desactiva también en producción.
El arranque de Render aplica migraciones antes de iniciar la API y el consumidor.
El worker vive en el mismo proceso NestJS,
consulta cada segundo cuando no hay trabajo y espera la operación activa al cerrar.
Los trabajos `DISPUTE_CHANGED` permanecen pendientes para M07.

## Contrato HTTP

Ambas rutas exigen JWT Supabase y membresía activa; ADMIN y VIEWER pueden leer.
El merchant siempre se obtiene de M01, no de parámetros del cliente.

| Método | Ruta                    | Comportamiento                          |
| ------ | ----------------------- | --------------------------------------- |
| GET    | `/api/transactions`     | `{ items, page, pageSize, total }`      |
| GET    | `/api/transactions/:id` | Detalle de una transacción del merchant |

Filtros del listado: `page` (1–100000, defecto 1), `pageSize` (1–100, defecto 20),
`paypalCaptureId` (coincidencia exacta). Orden descendente por creación e ID.
Listado y conteo usan una misma instantánea PostgreSQL. UUID o query inválidos
devuelven 400; detalle inexistente o perteneciente a otro merchant devuelve 404.

Los schemas Zod públicos están en `packages/contracts/src/transactions.ts`.
La respuesta expone procedencia mediante `sourceEventId`, pero no el payload
completo del webhook ni información de credenciales.

## Readiness y límites

El checklist tiene `PAYMENT_RECORD`, `ORDER_REFERENCE`, `ORDER_RECORD`, `TRACKING`
y `PROOF_OF_DELIVERY`. Solo los dos primeros pueden estar `PRESENT` en este
incremento. El resto se marca `MISSING`; el estado global permanece `INCOMPLETE`.
Esto describe cobertura documental, nunca probabilidad de ganar una disputa.

Pendientes para completar M03 y su coordinación con M04: adaptador de pedidos
comerciales, registro de órdenes, expediente/evidencia y actualización de readiness
a partir de fuentes documentales reales o fixtures identificados. No se incluye
`refresh-evidence` sin un consumidor implementado. No se desplegó M03 a Render.
Sí se verificó el consumidor local con dos capturas genuinas que M02 había
persistido en Supabase y con un nuevo pago Sandbox: captura HTTP 201, webhook
genuino recibido por Render, trabajo completado y listado/detalle locales HTTP 200.
Ver [validación](validation.md) para identificadores y alcance.

## Verificación

Pruebas unitarias: normalización, importes inválidos, estado, referencias ausentes
y paginación. Pruebas PostgreSQL/HTTP: comunicación M02–M03, persistencia,
duplicados concurrentes, conflictos, rollback/reintento, rechazo de datos,
aislamiento merchant, autenticación, paginación y RLS. En las suites automatizadas,
PayPal y JWKS son MOCK explícitos; la app NestJS y PostgreSQL son reales.
La comprobación Sandbox descrita arriba utilizó PayPal, Supabase Auth y
PostgreSQL Supabase reales, sin mocks.
