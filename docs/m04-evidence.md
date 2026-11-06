# M04 — Base de evidencia estructurada para M03

Esta entrega implementa la parte de M04 necesaria para que M03 coordine un
expediente y actualice su checklist. No implementa todavía el Evidence Vault
completo para archivos, PDFs, imágenes o Supabase Storage.

## Propiedad y contrato entre módulos

M04 es propietario de `evidence_dossiers` y `evidence_items`. M03 es propietario
de `transactions` y `merchant_orders`. La dependencia NestJS va de M03 a M04,
sin ciclos. M04 no lee ni escribe tablas de M03: recibe `EvidenceContext`
con merchant, captura, fuente PayPal y pedido ya autorizado por M03.

La interfaz pública exporta `EvidenceService` y `EvidenceContext`:

- `syncBase(tx, context)`: crea el expediente y agrega snapshots normalizados
  de pago/pedido. Se usa dentro de la misma transacción que ingesta o vincula.
- `register(tx, context, input, actorUserId)`: registra tracking o entrega de
  una fuente explícita y devuelve ID, versión y resultado real de persistencia.
- `readinessFor(tx, contexts)`: devuelve cobertura, IDs y motivos para el snapshot
  de las transacciones solicitadas. El listado comparte una instantánea consistente.
- `dossier(tx, context)`: devuelve originales estructurados y todas sus versiones.

Las claves foráneas compuestas impiden asociar un pedido o expediente a una
transacción de otro merchant. Las tres tablas nuevas tienen RLS sin políticas
públicas. Solo el backend autorizado accede a datos de evidencia.

## Registros, procedencia e integridad

Tipos: `PAYMENT_RECORD`, `ORDER_RECORD`, `TRACKING`, `PROOF_OF_DELIVERY`.
Los dos primeros se generan exclusivamente desde los datos persistidos de M03.
El registro PayPal es una representación normalizada con `sourceEventId`; el
webhook original completo permanece en M02. No es una nueva consulta a PayPal.

Tracking y entrega requieren merchant order reference y capture ID coincidentes,
carrier, tracking y fechas. El cliente no puede marcar evidencia como PayPal o
verificada: las entradas públicas admiten únicamente `MERCHANT_INPUT` o `DEMO`.
`MERCHANT_INPUT` identifica quién aportó los datos; no certifica su autenticidad.

Cada item conserva contenido JSON, hash SHA-256 canónico, sistema/referencia de
origen, fecha de recuperación, actor y fecha de registro. La API no permite editar
o borrar versiones existentes. Un duplicado devuelve el ID original. Cambiar
contenido agrega una versión, serializada por un lock del expediente. El máximo
es 256 versiones por expediente; superarlo devuelve 409 y requiere revisión.

Una misma fuente no puede cambiar de DEMO a real cambiando solo la etiqueta.
Tampoco puede hacer que un contenido antiguo reemplace una corrección más reciente.
El historial expone `current` y `integrity`, sin tokens o secretos. El hash detecta
alteraciones del contenido; no es una firma del carrier ni evita que un propietario
de la base con acceso privilegiado altere simultáneamente contenido y hash.

## Readiness y revisiones

El evaluador comprueba identidad, hashes, fechas y coherencia de un paquete.
Tracking de otro paquete, entrega anterior al envío/pedido, envío cancelado,
pedido contradictorio o contenido alterado impiden `READY`. Una entrega
`RETRACTED` vuelve a faltar aunque el registro anterior siga en el historial.
`containsDemo=true` advierte si el pedido o evidencia vigente incluye simulaciones.

`READY` significa cobertura estructurada. La evaluación semántica e independiente
de fuentes corresponde al futuro M06, y el permiso de envío corresponde a M08.

## Uso HTTP

La autorización y el contexto de transacción se resuelven en el controlador M03:
`GET/POST /api/transactions/:id/evidence`. Las escrituras exigen ADMIN; las lecturas
admiten ADMIN/VIEWER y están limitadas al merchant del JWT.

Ejemplo DEMO de registro de tracking; sustituir las referencias por las del pedido
y captura de prueba. No usarlo para presentar una entrega ficticia como real:

```json
{
  "type": "TRACKING",
  "sourceKind": "DEMO",
  "sourceSystem": "DEMO / MOCK carrier",
  "externalReference": "SHIP-DEMO-001",
  "retrievedAt": "2026-11-06T03:00:00Z",
  "content": {
    "paypalCaptureId": "MOCK-CAPTURE",
    "merchantOrderReference": "MOCK-MERCHANT-ORDER",
    "carrier": "MOCK-CARRIER",
    "trackingNumber": "MOCK-TRACK-001",
    "shippedAt": "2026-11-06T01:00:00Z",
    "status": "IN_TRANSIT"
  }
}
```

Para una prueba de entrega usar `type=PROOF_OF_DELIVERY`, `deliveredAt` en lugar
de `shippedAt`, estado `DELIVERED` o `RETRACTED`, y el mismo carrier/tracking.
Sin pedido coincidente la escritura devuelve 409. Fechas futuras/inconsistentes
devuelven 400; fuente/versión en conflicto, 409. Los GET no crean expedientes:
las capturas anteriores a esta migración pueden inicializarlos con
`POST /api/transactions/:id/refresh-evidence`.
