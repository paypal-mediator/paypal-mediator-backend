# Fuentes de información de pedidos (M03/M04)

PayPal es el primer adaptador conectado, no la fuente comercial exclusiva.
M01 conserva las credenciales; M03 coordina consultas y asociaciones; M04 conserva
los originales y los registros normalizados por fuente, con hash e historial.
El frontend consume contratos autenticados y nunca recibe tokens OAuth de PayPal.

## Recorrido

1. M02 verifica `PAYMENT.CAPTURE.COMPLETED` y persiste su outbox.
2. M03 guarda la captura y agenda `OrderSourceJob` por proveedor en la misma
   transacción, sin peticiones externas. Un webhook duplicado no reinicia el trabajo.
3. El worker consulta `GET /v2/checkout/orders/{id}` después de confirmar la captura,
   mediante el OAuth público de M01 y el host fijo de Sandbox. No mantiene una
   transacción PostgreSQL abierta durante la consulta HTTP.
4. La asociación busca el ID de la captura dentro de `purchase_units[].payments.captures`.
   No elige arbitrariamente la primera unidad. Varias capturas, capturas parciales,
   identidades, monedas o importes contradictorios requieren revisión.
5. M04 agrega `ORDER_SOURCE_RECORD` con el JSON original y la normalización,
   y `ORDER_RECORD` por fuente disponible. Ningún registro manual/DEMO se
   renombra ni se sobrescribe con origen PayPal. Los originales JSON viven en
   PostgreSQL privado; los adjuntos PDF/PNG/JPEG siguen en Storage privado.

La lectura de una orden no prueba envío ni entrega. El checklist sigue exigiendo
tracking y prueba de entrega para `READY`, que significa cobertura documental.

## Contrato y reintentos

`GET /api/transactions` y `GET /api/transactions/:id` agregan `orderEnrichment`:
estado global y registros por proveedor con intentos, fechas, próximo intento,
error sanitizado/HTTP, integridad, evidencia original y datos normalizados.
Estados: `UNAVAILABLE`, `PENDING`, `FETCHING`, `COMPLETE`, `PARTIAL`, `CONFLICT`,
`FAILED`, `NOT_CONFIGURED`. Los dos últimos no eliminan la captura ni el último
resultado válido; consultar `lastSucceededAt` para distinguir un snapshot previo.

Los campos no proporcionados se devuelven como `null`, los artículos ausentes
como `[]`, y sus rutas figuran en `missingFields`: significan **UNAVAILABLE**.
Los importes mantienen sus cadenas decimales exactas, incluidos ceros explícitos.
No se inventan SKU, descripción, cantidad, invoice ni breakdowns de cero.
El `externalId` PayPal es su ID de orden; `merchantOrderReference` e `invoiceId`
son campos separados y opcionales. Cada artículo conserva su propia cantidad,
SKU, descripción, moneda y precio unitario.

`order` ahora es la unión del pedido manual anterior y del contrato de fuente
con campos opcionales representados por `null`. Un pedido manual vinculado tiene
prioridad de visualización; después PayPal y luego otros proveedores por ID.
Esto no convierte esa fuente en autoridad universal: los registros independientes
siguen en `orderEnrichment` y en el expediente, y los conflictos bloquean readiness.
`merchantOrderId` continúa refiriendo exclusivamente al pedido manual; para fuentes
conectadas se usa `orderLink`, sin insertar datos ficticios en esa tabla.

`POST /api/transactions/:id/refresh-order-sources` (ADMIN) agenda/reintenta/backfill
solo adaptadores registrados por el servidor, y devuelve el snapshot actualizado.
Una consulta fallida puede devolver HTTP 201 con `FAILED`: no significa que PayPal
haya respondido correctamente. Un trabajo activo devuelve 409. VIEWER puede leer,
pero no ejecutar consultas; otra membresía no puede acceder a la transacción.

Los fallos transitorios (red/timeout, OAuth, 429/5xx) tienen backoff exponencial y
cinco intentos automáticos como máximo. 403/404 son terminales hasta un refresh
explícito. Una lease permite recuperar trabajos tras reinicios y evita que un
consumidor antiguo sobrescriba un resultado nuevo. Respuestas limitadas a 1 MiB,
timeout configurado, redirecciones rechazadas y ningún cuerpo de error en logs.
Reconsultar un original sin cambios no crea nuevas versiones de evidencia.

## Extender con ERP

Implementar `OrderInformationSource` en `transactions/sources` y registrarlo en
`ORDER_INFORMATION_SOURCES` dentro del módulo NestJS. Cada adaptador declara su
`providerId`, `sourceKind`, `sourceSystem`, asociación soportada y `fetch`.
Devuelve el original y `OrderSourceResult`, validado con el contrato compartido.
Usar `CONNECTED_SYSTEM` para ERP; obtener credenciales mediante M01 cuando se
implemente esa conexión. No aceptar URLs, credenciales ni procedencia confiable
desde un POST del cliente. Un registro por proveedor y captura permite coexistencia;
las pruebas incluyen un segundo adaptador ERP explícitamente MOCK.

Todavía no hay un ERP real conectado. La interfaz está implementada y probada;
cada ERP requerirá su autorización, correspondencias de identificadores y pruebas.
Los registros manuales y DEMO continúan siendo fuentes independientes.

## Validación

Las suites automatizadas usan PostgreSQL real desechable y PayPal/JWKS/ERP MOCK.
Incluyen ausencia de referencias/artículos/breakdowns, varios artículos, decimales,
asociación por captura, 401/403/404/429/500, timeout, límites de respuesta,
reintentos, duplicados, backfill, leases y contradicciones.
La prueba externa Sandbox se documenta por separado en `docs/validation.md`.

Referencia oficial: <https://developer.paypal.com/api/orders/v2/orders-get>.
