# Respaldo de seguimiento con 17TRACK v2.4

## Alcance y fuentes existentes

El backend conserva NestJS modular, Prisma/PostgreSQL y contratos Zod. El frontend
está en el repositorio anidado `paypal-mediator-frontend`; sus cambios se revisan y
versionan en ese repositorio. No se sustituye ninguna integración.

| Integración     | Archivos y comportamiento existente                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERP             | `apps/api/src/modules/integrations/integrations.controller.ts` publica `/api/integrations`, catálogo, conexión, sincronización y vinculación. `integrations.service.ts` controla `ERP_SYNC`, cursores, `ExternalRecord` y `TransactionLink`.                                                                                                                |
| Adaptadores ERP | `interfaces/erp-connector.interface.ts`, `adapters/bind.adapter.ts`, `adapters/mock-erp.adapter.ts`. `pullSalesOrders`, `pullInvoices`, `pullPayments` y `pullShipments` son los puntos de extensión. Bind todavía devuelve listas vacías; MockERP está etiquetado DEMO y no aporta envíos. Odoo/Siigo están en el catálogo, sin adaptadores implementados. |
| PayPal          | `modules/merchants/paypal/paypal-auth.service.ts` mantiene OAuth; `paypal-connection.client.ts` comprueba conexión/disputas. `modules/transactions/sources/paypal-order-source.ts` obtiene Orders v2, guarda originales mediante M04 y ahora comparte su transporte para la lectura de tracking v1.                                                         |
| Pedidos y pagos | M02 verifica webhooks; M03 consume capturas, vincula `MerchantOrder`, `invoiceId`, `merchantOrderReference` y `paypalOrderId`. `OrderSourceJob` conserva leases, intentos, backoff y errores de enriquecimiento.                                                                                                                                            |
| Evidencia       | M04 conserva `TRACKING` y `PROOF_OF_DELIVERY` manuales/DEMO con integridad y versiones. M07 vincula disputas por captura y mantiene separado el estado oficial de PayPal.                                                                                                                                                                                   |

Las rutas de PayPal utilizadas por el seguimiento son exclusivamente de lectura:
`GET /v2/checkout/orders/{orderId}` y
`GET /v1/shipping/trackers/{captureId}-{trackingNumber}`. Los trackers se descubren
solo dentro de la unidad de compra que contiene esa captura. Se comprueban los
identificadores de pedido, captura y guía antes de aceptar la respuesta. Una
actualización de estado de PayPal conserva su significado; no se inventan scans
ni fechas de entrega a partir de `shipment_date`.

La configuración PayPal existente es Sandbox y sus credenciales globales pertenecen
al `MERCHANT_ID` configurado. Otros negocios reciben `NOT_CONFIGURED` para PayPal y
pueden usar sus registros ERP y el respaldo configurado.

## Resolución y selección

La interfaz pública es
`ShipmentTrackingService.resolveShipmentTracking(merchantId, transactionId, input)`.
El merchant procede de la membresía autenticada; no se recibe en el cuerpo HTTP.

1. Autoriza la transacción mediante la interfaz pública M03 y obtiene pedido,
   factura y expediente. Recupera el trabajo persistente o crea uno.
2. Si hay una ejecución activa o una caché vigente, devuelve el estado guardado.
   Un cambio de clave del proveedor invalida la caché de configuración.
3. Consulta PayPal primero, descubriendo guías o usando la guía indicada.
4. Si PayPal no aporta seguimiento suficiente, consulta la interfaz pública ERP.
   Solo se aceptan asociaciones exactas de captura/pedido/factura o vínculos
   revisados, nunca coincidencias por importe o correo ni sugerencias sin revisar.
   Conserva los registros sincronizados y permite lecturas de hasta tres páginas
   del adaptador de envíos existente.
5. Obtiene la guía de esas fuentes, de evidencia vigente con integridad válida o
   de una indicación ADMIN. Las guías DEMO no se registran automáticamente. Si se
   descubre una guía en ERP/evidencia, consulta primero PayPal para esa guía.
6. Si las fuentes anteriores y el historial guardado no son suficientes, usa
   17TRACK. Aprovecha un código numérico de transportista disponible en el ERP;
   cuando falta, omite `carrier` para permitir autodetección.
7. Guarda originales y observaciones, combina eventos sin duplicados y selecciona
   una fuente suficiente según el orden PayPal → ERP → 17TRACK. Datos anteriores
   más completos no se reemplazan por respuestas antiguas o parciales.

Una fuente suficiente tiene estado conocido, eventos fechados y actualización
reciente (72 horas por defecto), sin problemas de procedencia, sincronización ni
marcas DEMO. Una entrega fechada y reportada se conserva como evento terminal;
no exige repetir consultas porque su fecha sea antigua. Una guía por sí sola,
`NotFound` o un estado sin eventos/fecha no bastan.

Se distinguen `ABSENT`, `STALE`, `TEMPORARY_ERROR`, `PERMANENT_ERROR`,
`NOT_CONFIGURED` y el estado global `NEEDS_REVIEW`. Las observaciones originales y
sus fuentes se conservan aunque falle otra consulta. Un resultado incompatible
con una entrega/cancelación reportada, códigos de carrier diferentes o una
identificación incierta de carrier requieren revisión. Si hay varias guías y no
se indicó una, no se registra una guía elegida arbitrariamente.

## Contrato ERP de envíos

`IntegrationsService.shipmentRecords` lee sus propias tablas y adaptadores. Las
referencias exactas admitidas son `paypalCaptureId`, `paypalOrderId`,
`merchantOrderReference`, `orderExternalId`, `invoiceId`, `invoiceNumber` y
`orderId`. Un registro comercial vinculado puede contener `shipment` o un arreglo `shipments`.
El adaptador debe entregar su envío en el contrato interno siguiente; estos campos
no pretenden ser campos de las APIs particulares de Bind u Odoo:

```json
{
  "paypalCaptureId": "CAPTURE_MOCK",
  "trackingNumber": "MOCKGUIDE123",
  "carrier": "MOCK Carrier",
  "carrierCode": 100003,
  "status": "IN_TRANSIT",
  "updatedAt": "2026-11-11T12:00:00Z",
  "events": [
    {
      "occurredAt": "2026-11-11T12:00:00Z",
      "status": "IN_TRANSIT",
      "description": "MOCK movement",
      "location": "MOCK location"
    }
  ]
}
```

`carrierCode` es opcional y debe ser un código de **17TRACK**, no un identificador
arbitrario del ERP. Si se reporta entrega, `deliveredAt` o un evento `DELIVERED`
pueden indicar la fecha; nunca se deduce la fecha a partir de la consulta.

## HTTP y consumo

| Método | Ruta                                              | Acceso                                                 |
| ------ | ------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/transactions/:id/shipment-tracking`         | ADMIN/VIEWER, sin consultas externas                   |
| POST   | `/api/transactions/:id/shipment-tracking/resolve` | ADMIN                                                  |
| GET    | `/api/disputes/:id/shipment-tracking`             | ADMIN/VIEWER; disputa vinculada sin conflicto          |
| POST   | `/api/disputes/:id/shipment-tracking/resolve`     | ADMIN; misma resolución sobre la transacción vinculada |
| GET    | `/api/shipment-tracking/usage`                    | ADMIN; consumo del negocio en el día UTC               |
| POST   | `/api/webhooks/17track`                           | Firma del proveedor, sin JWT de usuario                |

El POST acepta `{}` o campos opcionales. Un ADMIN puede incluir `retryFailed: true`
para reintentar una operación detenida después de corregir la causa; el indicador
no se guarda para reintentos automáticos, no omite presupuestos y no reactiva un
tracking detenido por el proveedor:

```json
{
  "trackingNumber": "MOCKGUIDE123",
  "carrierCode": 100003,
  "destinationPostalCode": "12345",
  "originCountry": "MX",
  "shipDate": "2026/11/10"
}
```

El cliente traduce a los campos oficiales `number`, `carrier`,
`destination_postal_code`, `origin_country` y `ship_date`. Las llamadas son arrays
JSON a `POST https://api.17track.net/track/v2.4/register` y `.../gettrackinfo` con
cabecera `17token`. Se validan `code`, `data.accepted` y `data.rejected`, la guía y
el carrier de la respuesta. Se normalizan `track_info.latest_status`, eventos de
`tracking.providers`, `latest_event` y el milestone de entrega. Los cuerpos de
respuesta están acotados a 1 MiB y los errores públicos no incluyen mensajes
privados ni cabeceras del proveedor.

Las protecciones de consumo incluyen:

- Registro persistente por negocio, cuenta, guía y carrier solicitado, con
  reutilización de un carrier que ya fue detectado para la misma guía.
- Leases transaccionales para evitar consultas/registro simultáneos, con
  recuperación tras caída del proceso. Un registro incierto por timeout se
  comprueba con `gettrackinfo` antes de intentar otro `register`.
- `ALREADY_REGISTERED` se trata como registro existente. Una guía rechazada de
  forma definitiva no se repite automáticamente; agregar campos obligatorios o
  corregir el carrier permite un nuevo intento controlado.
- Gate compartido en PostgreSQL que reserva solicitudes separadas por 400 ms,
  por cuenta API, incluso con varias instancias. Un `429` comparte su cooldown
  `Retry-After` con las otras guías de la misma cuenta.
- Presupuestos diarios por negocio para solicitudes e intentos de registro.
  Los intentos reservados cuentan de manera conservadora aunque falle la red.
- Caché de 6 horas por defecto; para un registro aún sin resultados, caché corta
  de 30 segundos. Hasta cinco intentos automáticos con backoff de 30, 60, 120 y
  240 segundos, respetando `Retry-After` y los presupuestos. Sin bucles indefinidos
  frente a errores permanentes o falta repetida de datos.
- Métricas de solicitudes, intentos/aceptaciones de registro, consultas, fallos y
  webhooks. Son contadores de uso observados, no una factura ni una estimación
  garantizada del costo monetario del proveedor.

Según la documentación oficial, para carriers estándar se consume un envío por
registro; durante el seguimiento automático no se vuelve a cobrar ese mismo
registro. Cambiar de carrier o eliminar y volver a registrar puede consumir otro
envío. Los canales especiales tienen condiciones propias. `gettrackinfo` consulta
los datos guardados del registro y no fuerza una nueva lectura al carrier. Esta
integración no invoca `getRealTimeTrackInfo`, borrado, cambio de carrier ni
`retrack`. Confirmar cuotas, carriers y condiciones vigentes en la cuenta de
17TRACK antes de habilitar el worker.

## Persistencia y expediente de disputa

El módulo `shipment-tracking` es propietario de:

- `shipment_tracking_jobs`: entrada, estado, leases, intentos, errores,
  próxima sincronización y último evento de disputa observado.
- `shipment_tracking_snapshots`: observación normalizada, respuesta original,
  hash, fuente, guía, carrier y vínculo compuesto a transacción/merchant.
- `tracking_registrations`: registro/caché por cuenta y contexto, carrier
  detectado, origen de detección, errores y lease.
- `tracking_usage` y `tracking_api_gates`: métricas y control compartido de consumo.

M03 aporta el contexto público de transacción/pedido; M07 aporta las disputas
vinculadas. M04 recibe el informe por `recordShipmentTracking`, conserva el tipo
`SHIPMENT_TRACKING_RECORD`, el original, el hash y las versiones, y registra la
operación por su auditoría existente. No se escriben tablas privadas de otros
módulos directamente desde seguimiento.

Los eventos de tracking no crean `PROOF_OF_DELIVERY` ni completan automáticamente
el checklist documental. La respuesta incluye `deliveryReported`, `deliveredAt`
si existe y `documentaryProof: false`. Una discrepancia conservada en el informe
requiere revisión del expediente. Los agentes pueden consultar el original por
las herramientas existentes; sus permisos de envío permanecen sujetos a M08.
Este módulo no envía evidencia, responde disputas ni ejecuta reembolsos automáticamente.

## Webhooks y trabajo en segundo plano

Configurar en el dashboard 17TRACK la URL pública
`https://<backend>/api/webhooks/17track` y activar la variable correspondiente.
La firma `sign` debe ser el SHA-256 hexadecimal de los **bytes originales** del
cuerpo, seguidos de `/` y la clave API. La comparación usa tiempo constante.

Se admiten `TRACKING_UPDATED` y `TRACKING_STOPPED`. Solo se procesan guías que ya
tengan un registro local de esa cuenta; el mensaje no puede elegir un merchant
ni asociarse a una transacción arbitraria. Las actualizaciones se incorporan a
los trabajos vinculados, se deduplican y conservan el estado más reciente ante
mensajes reordenados. Un tracking detenido no se vuelve a registrar a ciegas.

`ShipmentTrackingWorker` usa el patrón de polling y leases existente, sin depender
de pg-boss. Con opt-in explícito recorre transacciones por páginas, crea trabajos,
detecta cambios en disputas vinculadas y resuelve trabajos vencidos. Los trabajos
son por negocio; el worker atiende varios merchants, aunque PayPal siga limitado
al merchant cuyas credenciales están configuradas. Se conserva el pg-boss opcional
existente y su limitación previa de inicialización; esta entrega no afirma haber
reparado el adaptador de jobs ERP ni haber completado conectores ERP externos.

## Configuración

Todas las variables están en `.env.example`; nunca deben ir en variables Vite ni
en el navegador.

| Variable                                  | Predeterminado | Uso                                                       |
| ----------------------------------------- | -------------- | --------------------------------------------------------- |
| `SEVENTEENTRACK_API_KEY`                  | sin clave      | Token servidor de 17TRACK                                 |
| `SEVENTEENTRACK_TIMEOUT_MS`               | `10000`        | Timeout por solicitud                                     |
| `SEVENTEENTRACK_WEBHOOK_ENABLED`          | `false`        | Habilita recepción firmada                                |
| `SEVENTEENTRACK_DAILY_REGISTRATION_LIMIT` | `100`          | Intentos diarios por negocio; `0` impide registros nuevos |
| `SEVENTEENTRACK_DAILY_REQUEST_LIMIT`      | `1000`         | Solicitudes diarias por negocio; `0` impide llamadas      |
| `SHIPMENT_TRACKING_WORKER_ENABLED`        | `false`        | Activa sincronización automática                          |
| `SHIPMENT_TRACKING_CACHE_SECONDS`         | `21600`        | Ventana de caché/consulta regular                         |
| `SHIPMENT_TRACKING_FRESH_HOURS`           | `72`           | Vigencia de eventos no terminales                         |

También se usan `DATABASE_URL`, `DIRECT_URL`, Supabase Auth y la configuración
PayPal existente. Se revisaron los nombres de las variables locales sin copiar
valores al código ni a esta guía. Para habilitar la integración real faltan una
clave de 17TRACK y una cuenta con cuota; para webhooks faltan además su URL pública
y configuración. El worker permanece apagado por defecto.

## Archivos de esta entrega

Nuevos:

- `packages/contracts/src/shipment-tracking.ts`.
- `apps/api/src/modules/shipment-tracking/`: `index.ts`,
  `shipment-tracking.module.ts`, `shipment-tracking.service.ts`,
  `shipment-tracking.controller.ts`, `shipment-tracking.worker.ts`,
  `seventeentrack.client.ts`, `tracking-registration.service.ts`,
  `tracking-normalization.ts`, `paypal-tracking.source.ts`,
  `tracking-webhook.service.ts`.
- Migraciones `20261111000000_shipment_tracking_fallback` y
  `20261111010000_erp_tracking_prerequisites`.
- `apps/api/test/fixtures/shipment-tracking.ts`,
  `apps/api/test/unit/shipment-tracking.spec.ts`,
  `apps/api/test/integration/shipment-tracking.db.spec.ts`.
- `paypal-mediator-frontend/src/ShipmentTrackingCard.jsx` y esta guía.

Modificados:

- `.env.example`, `eslint.config.mjs` (el lint del backend excluye el repositorio
  frontend anidado, que tiene su propio lint).
- `apps/api/test/http/http.spec.ts`: contrato de rutas OpenAPI.
- `apps/api/prisma/schema.prisma`, `apps/api/src/app.module.ts`,
  `apps/api/src/common/config/environment.ts`.
- `modules/integrations/integrations.service.ts`,
  `modules/disputes/disputes.service.ts`,
  `modules/transactions/transactions.service.ts`, `transactions.module.ts`,
  `index.ts`, `sources/paypal-order-source.ts`.
- `modules/evidence/evidence.service.ts`, `evidence-readiness.ts`;
  `packages/contracts/src/evidence.ts`, `monitoring.ts`, `index.ts`.
- Frontend: `src/LiveEvidence.jsx`, `src/LiveDisputes.jsx`, `src/lib/api.js`,
  `src/styles.css`, `test/live-api.test.js`.
- `docs/architecture.md` e `information.md`: referencia a este incremento.

La primera migración añade únicamente persistencia privada de seguimiento y el
nuevo tipo de evidencia. La segunda crea las tablas ERP que ya estaban definidas
en Prisma pero faltaban en el historial; no borra ni reemplaza datos existentes.
Usa creación condicional para una instalación donde esas tablas ya existan.
No se ejecutan migraciones contra producción como parte de esta entrega.

## Verificación y límites

Las pruebas usan HTTP NestJS, PostgreSQL desechable y JWT/JWKS, PayPal, ERP y
17TRACK **MOCK**. Cubren prioridades, ausencia y antigüedad, errores por guía,
backoff, credenciales ausentes, registro incierto, límites de consumo,
concurrencia, caché, campos adicionales, carrier ERP, entrega reportada,
contradicciones, aislamiento por merchant, roles, webhooks firmados/reordenados,
RLS y expediente de disputa sin presentación automática.

Validación local ejecutada el 11 de noviembre de 2026, con Node 24.22.3 y
PostgreSQL 18.6 desechable:

- `pnpm check`: aprobado; generación/validación Prisma, lint, formato, tipos,
  **226 pruebas unitarias/HTTP** y build. Incluye 16 pruebas unitarias nuevas del
  transporte/normalización de seguimiento y de lectura PayPal.
- `pnpm test:db`: **140 pruebas aprobadas**, incluidas **28 de seguimiento**.
  Validación del incremento aislado de seguimiento, sin cambios de mediación.
- `pnpm db:deploy`: historial aplicado a una base vacía, incluidas las dos
  migraciones de esta entrega; repetición sin migraciones pendientes. Se usaron
  exclusivamente URLs locales de pruebas para migraciones y persistencia.
- Frontend anidado: `npm test` (**35 pruebas**), `npm run lint`,
  `npm run typecheck` y `npm run build` aprobados.
- PayPal/ERP/17TRACK/JWKS/LLM de las pruebas son MOCK. No se hicieron consultas ni
  registros reales de 17TRACK, no se consumieron créditos y no se desplegó código
  ni se aplicaron migraciones a producción.

Las pruebas automáticas no prueban acceso real a una cuenta 17TRACK ni consumen sus
créditos. El frontend reutiliza las tarjetas y estados remotos existentes en el
expediente y la disputa; muestra guía, carrier, estado, fecha, movimientos y
`17TRACK` como fuente. La lectura es gratuita desde la base local; solo una acción
ADMIN o el worker habilitado puede iniciar consultas externas.

## Documentación oficial consultada

- [17TRACK v2.4: API, errores, cuotas, estados y firma webhook](https://api.17track.net/en/doc).
- [Documentación estática oficial v2.4](https://asset.17track.net/api/document/v2.4_en/index.html).
- [PayPal: leer seguimiento de una captura](https://developer.paypal.com/api/tracking/track-orders/use/).
- [PayPal: tracking asociado a Orders v2](https://developer.paypal.com/api/orders-v2/track-orders/use/).
