# M07 — Dispute Orchestrator

Ingesta, vinculación y estado interno de disputas PayPal para el merchant
configurado. No presenta evidencia ni llama a la API de disputas de PayPal: este
incremento consume exclusivamente eventos `CUSTOMER.DISPUTE.CREATED`,
`CUSTOMER.DISPUTE.UPDATED` y `CUSTOMER.DISPUTE.RESOLVED` que M02 ya verificó y
persistió.

No se ha validado todavía con una disputa Sandbox genuina. Todas las pruebas
automatizadas usan payloads DEMO / MOCK; la presentación de evidencia
(`provide-evidence`) es alcance de M08.

## Consumo y persistencia

`DisputesService.processNextDispute(merchantId)` usa la interfaz pública
`IngestionQueueService` de M02. M02 conserva la propiedad de `webhook_events` e
`ingestion_jobs`; M07 escribe únicamente `disputes` y `dispute_events` dentro de
la transacción recibida. El consumidor solo procesa trabajos `DISPUTE_CHANGED`
del entorno `sandbox`.

El parser `parseDisputeEvent` valida el sobre y el `resource` de PayPal con Zod.
Los datos inválidos producen `FAILED/INVALID_DISPUTE` y revierten las escrituras
del consumidor mediante el savepoint de M02. Los errores inesperados revierten
toda la transacción y el trabajo permanece `QUEUED` para reintento.

Un advisory lock transaccional por `merchantId:environment:paypalDisputeId`
serializa eventos distintos de la misma disputa. La unicidad es por merchant,
entorno y `paypal_dispute_id`; cada evento de webhook se registra una sola vez.

## Estados separados

PayPal y el flujo local nunca se mezclan:

- `paypal_status`: `OPEN`, `WAITING_FOR_BUYER_RESPONSE`,
  `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED` u `OTHER`.
- `paypal_stage`: `INQUIRY`, `CHARGEBACK`, `PRE_ARBITRATION`, `ARBITRATION` u
  `OTHER`.
- `paypal_outcome`: código oficial de PayPal, o `null`.
- `internal_state`: `DETECTED`, `LINKED`, `NEEDS_REVIEW`, `RESOLVED_WON`,
  `RESOLVED_LOST` o `CLOSED`.

Los valores PayPal desconocidos se conservan como `OTHER`; no se normalizan a un
estado inventado. `reason_category` agrupa el motivo oficial en
`ITEM_NOT_RECEIVED`, `NOT_AS_DESCRIBED`, `UNAUTHORIZED`, `DUPLICATE` u `OTHER`
para uso futuro de M05/M06. No predice el resultado.

Solo `RESOLVED_SELLER_FAVOUR` y `RESOLVED_BUYER_FAVOUR` producen
`RESOLVED_WON`/`RESOLVED_LOST`. Un estado `RESOLVED` sin código oficial, o un
evento `CUSTOMER.DISPUTE.RESOLVED` cuyo estado no es `RESOLVED`, queda en
`NEEDS_REVIEW`; nunca se infiere un ganador.

## Vinculación con M03

La única referencia aceptada es `disputed_transactions[].seller_transaction_id`,
que corresponde a una captura PayPal. M07 consulta `transactions` mediante
Prisma por `merchantId`, `environment=sandbox` y `paypal_capture_id`; no escribe
tablas de M03.

- Coincidencia única: `link_status=LINKED` e `internal_state=LINKED`.
- Sin referencias conocidas: `UNLINKED/TRANSACTION_NOT_FOUND` y
  `NEEDS_REVIEW`.
- Varias capturas coincidentes o referencias desconocidas: `CONFLICT`, sin
  reemplazar un vínculo existente.
- Referencia distinta a la ya vinculada: `CONFLICT`,
  `TRANSACTION_REFERENCE_CHANGED`; se conserva el vínculo original.

Un conflicto no descarta la disputa real: se conserva y se expone para revisión.

## Idempotencia y orden

Los eventos se aplican por `occurredAt` (el `create_time` del webhook). Un evento
más antiguo que el último aplicado se guarda como `IGNORED_STALE`. Contenido
idéntico al estado actual se guarda como `IGNORED_DUPLICATE` y actualiza
`last_event_at`. Los cambios reales se guardan como `APPLIED`. El timeline del
detalle se ordena por `occurred_at`, por lo que un evento reordenado puede
aparecer antes de los eventos aplicados; el resultado de cada evento queda
explícito en `outcome`.

## Worker

`DISPUTE_WORKER_ENABLED` controla el consumidor. Si no se define, hereda
`TRANSACTION_WORKER_ENABLED` (habilitado por defecto en producción y deshabilitado
en desarrollo/pruebas). También requiere `MERCHANT_ID`. El worker vive en el mismo
proceso NestJS, consulta cada segundo cuando no hay trabajo, drena sin espera
cuando procesa uno y espera la operación activa al cerrar. Los errores se
registran solo como `DISPUTE_WORKER_UNAVAILABLE`; no se registran payloads,
credenciales ni cadenas de conexión.

## Contrato HTTP

Todas las rutas exigen JWT Supabase y membresía activa. ADMIN y VIEWER pueden
leer; este incremento no expone escrituras.

| Método | Ruta                | Comportamiento                                              |
| ------ | ------------------- | ----------------------------------------------------------- |
| GET    | `/api/disputes`     | `{ items, page, pageSize, total }`                          |
| GET    | `/api/disputes/:id` | Disputa del merchant con timeline ordenado por `occurredAt` |

Filtros del listado: `page` (1–100000, defecto 1), `pageSize` (1–100, defecto
20), `internalState` y `paypalStatus` con coincidencia exacta. El merchant se
obtiene de M01, nunca de parámetros del cliente. UUID o query inválidos devuelven
400; una disputa inexistente o de otro merchant devuelve 404.

Los schemas públicos están en `packages/contracts/src/disputes.ts`
(`DisputeSummarySchema`, `DisputeDetailSchema`, `DisputeListResponseSchema`). La
respuesta no expone el payload completo del webhook ni credenciales.

## Migración y despliegue

La migración es `20261106070000_disputes` y debe aplicarse después de las
migraciones de M05/M06 cuando estén integradas en la misma rama. No ejecutar
`migrate deploy` sobre una base compartida mientras el historial local no incluya
esas migraciones. `DISPUTE_WORKER_ENABLED` hereda `TRANSACTION_WORKER_ENABLED`
salvo override explícito; `render.yaml` no necesita declararlo.

## Verificación

Pruebas unitarias: normalización, clasificación de motivos, valores desconocidos,
resolución oficial, ausencia de resultado y scheduling del worker. Pruebas
PostgreSQL/HTTP: consumo M02–M07, vinculación con capturas reales de la suite,
duplicados, eventos reordenados, resolución, conflictos, datos inválidos,
aislamiento por merchant, autenticación, paginación, filtros y RLS. PayPal, JWKS
y las firmas son MOCK explícitos; NestJS y PostgreSQL son reales.

Pendiente: validar con una disputa Sandbox genuina y un `provide-evidence`
autorizado (M08). M07 no presenta evidencia, no cierra disputas en PayPal y no
sustituye la aprobación humana.
