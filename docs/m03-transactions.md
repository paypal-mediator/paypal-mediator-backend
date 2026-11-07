# M03 — Transaction Manager

Capturas, registro de órdenes comerciales, vinculación y preparación documental
por merchant dentro del backend NestJS. No crea pagos ni disputas. No hace llamadas
nuevas a PayPal: consume exclusivamente eventos que M02 ya verificó y persistió.

Capturas, órdenes y expedientes estructurados M04 están desplegados en Render
por PR #8 (`5dfae91`), con la quinta migración aplicada. La prueba completa con
un nuevo pago Sandbox validó M01/M02/M03 en Render y el historial M04 con datos
comerciales/envíos DEMO; ver [validación](validation.md).

## Consumo y persistencia

`TransactionsService.processNextCapture(merchantId)` utiliza la interfaz pública
`IngestionQueueService` de M02. M02 conserva la propiedad de sus eventos y trabajos;
el consumidor escribe únicamente `transactions` usando la transacción recibida.
La captura, sus registros base del expediente M04 y el estado `COMPLETED` del
trabajo se confirman juntos. Si M04 falla, se revierten captura, expediente y job.

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
Los trabajos `DISPUTE_CHANGED` los consume M07 con la misma interfaz; ver
[M07](m07-disputes.md).

## Órdenes y vinculación

`POST /api/orders` registra un pedido comercial inmutable: referencia externa,
referencia PayPal opcional, origen, fecha, artículos, cantidades, precios unitarios,
envío, impuestos y descuento. El total debe coincidir exactamente con
`sum(cantidad × precio) + envío + impuestos − descuento`. Los importes se calculan
con decimales de precisión suficiente para `DECIMAL(24,8)`, sin punto flotante.

El origen es explícito: `MERCHANT_INPUT` para datos aportados por el comerciante,
o `DEMO` para simulaciones. No hay integración automática con Shopify o carriers.
Los registros de prueba están en `apps/api/test/fixtures/commerce.ts` y están
etiquetados DEMO / MOCK. No se insertan fixtures automáticamente en Supabase.

La identidad del pedido es única por merchant/entorno y referencia externa; la
referencia PayPal también es única cuando existe. Repetir el mismo pedido devuelve
`DUPLICATE`; contenido distinto bajo una referencia existente devuelve 409.
No se sobrescriben los artículos originales. El hash del contenido normalizado
permite detectar cambios posteriores en el registro.

Un lock transaccional por merchant coordina llegada de pedido y captura, incluso
si ocurren simultáneamente. Se reevalúan tanto pagos anteriores como nuevos:

- Se busca por `custom_id = externalId` o por ID de orden PayPal.
- Si ambas referencias existen, deben ser consistentes e identificar un pedido.
- Moneda e importe deben coincidir y el pedido no puede ser posterior al pago.
- Alcance MVP: una captura completa por pedido y un paquete por expediente.
  Capturas parciales, pagos múltiples o paquetes contradictorios requieren revisión;
  no se concilian automáticamente.

La transacción incluye `order` y `orderLink`: `LINKED`, `UNLINKED` o `CONFLICT`,
con un código de motivo. Un conflicto comercial no elimina el pago real ni hace
fallar su ingesta: conserva la captura y devuelve readiness `NEEDS_REVIEW`.

Ejemplo de pedido DEMO para una captura de prueba de 10.25 USD cuyas referencias
sean `MOCK-MERCHANT-ORDER` y `MOCK-ORDER`. Enviar a `POST /api/orders` con JWT ADMIN:

```json
{
  "externalId": "MOCK-MERCHANT-ORDER",
  "paypalOrderId": "MOCK-ORDER",
  "sourceKind": "DEMO",
  "sourceSystem": "DEMO / MOCK commerce",
  "currencyCode": "USD",
  "totalAmount": "10.25",
  "orderedAt": "2026-11-05T00:00:00Z",
  "items": [
    {
      "sku": "MOCK-SKU",
      "description": "DEMO / MOCK physical item",
      "quantity": 1,
      "unitAmount": "10.25"
    }
  ]
}
```

Envío, impuestos y descuento omitidos se interpretan como cero. Para datos propios,
usar referencias/importes reales y `sourceKind=MERCHANT_INPUT`. Los ejemplos no
generan un pago ni se ejecutan automáticamente contra capturas Sandbox genuinas.

## Contrato HTTP

Todas las rutas exigen JWT Supabase y membresía activa. ADMIN y VIEWER pueden
leer; solo ADMIN puede registrar pedidos/evidencia o refrescar un expediente.
El merchant siempre se obtiene de M01, no de parámetros del cliente.

| Método | Ruta                                     | Comportamiento                                                           |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/transactions`                      | `{ items, page, pageSize, total }`                                       |
| GET    | `/api/transactions/:id`                  | Detalle de una transacción del merchant                                  |
| POST   | `/api/orders`                            | Registrar pedido y reconciliar capturas; `{ outcome, order }`            |
| GET    | `/api/orders`                            | Listado paginado; filtro exacto opcional `externalId`                    |
| GET    | `/api/orders/:id`                        | Pedido comercial del merchant                                            |
| POST   | `/api/transactions/:id/refresh-evidence` | Reconciliación y snapshot base de evidencia, síncronos                   |
| GET    | `/api/transactions/:id/evidence`         | Expediente estructurado, origen, hashes e historial                      |
| POST   | `/api/transactions/:id/evidence`         | Añadir tracking/entrega; `{ outcome, evidenceId, version, transaction }` |

Filtros del listado: `page` (1–100000, defecto 1), `pageSize` (1–100, defecto 20),
`paypalCaptureId` (coincidencia exacta). Orden descendente por creación e ID.
Listado y conteo usan una misma instantánea PostgreSQL. UUID o query inválidos
devuelven 400; detalle inexistente o perteneciente a otro merchant devuelve 404.

Los schemas Zod públicos están en `packages/contracts/src/transactions.ts`.
La respuesta expone procedencia mediante `sourceEventId`, el pedido asociado y
el snapshot documental; no expone el payload completo del webhook ni credenciales.
Se ampliaron `TransactionResponseSchema` y su enum de readiness. Los consumidores
de contratos deben recompilar y admitir los tres estados y los IDs de evidencia.

## Readiness y límites

El checklist tiene `PAYMENT_RECORD`, `ORDER_REFERENCE`, `ORDER_RECORD`, `TRACKING`
y `PROOF_OF_DELIVERY`. M03 entrega su contexto autoritativo a la interfaz pública
`EvidenceService` de M04; M04 guarda y consulta solo sus propias tablas. Cada check
devuelve `PRESENT`, `MISSING` o `CONFLICT`, con los IDs que lo respaldan.

- `INCOMPLETE`: falta algún registro.
- `READY`: todos están presentes, con referencias consistentes e integridad válida.
- `NEEDS_REVIEW`: contradicción, vínculo comercial inválido o integridad alterada.

El snapshot incluye `basis=DOCUMENT_COVERAGE`, `dossierId`, `evidenceRevision`,
`containsDemo` y códigos explicativos. Se calcula desde la instantánea actual de
PostgreSQL, también en el listado. Puede regresar de `READY` a incompleto/revisión
cuando la fuente retracta una entrega o cancela el envío. Datos antiguos no pueden
reemplazar una versión más reciente. El historial anterior se conserva.

Esto describe cobertura documental, nunca probabilidad de ganar una disputa,
autenticidad certificada del carrier ni autorización para enviar a PayPal.
No produce imágenes o capturas de pantalla. El soporte de M04 aquí es una base
de registros JSON estructurados; archivos binarios, Storage privado, conectores
comerciales y Verifier siguen pendientes. Ver [M04](m04-evidence.md).

El primer incremento de M03 se desplegó a Render
desde `main` por PR #6 (`ff12287`); readiness, listado y detalle autenticados
se comprobaron por HTTPS con HTTP 200 y acceso sin sesión HTTP 401.
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

# Fuentes conectadas

El incremento de fuentes de pedidos añade consulta automática de Orders v2 tras
capturas verificadas, retry/backfill y procedencia por proveedor sin depender de
una orden manual. Ver [contrato, estados y adaptadores ERP](order-information-sources.md).
