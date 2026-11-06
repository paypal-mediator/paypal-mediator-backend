# M04 — Evidence Vault: registros y archivos originales

M04 conserva registros estructurados y archivos originales versionados. La base
estructurada y las rutas de archivos están desplegadas en Render (PR #11,
`f49fd6c`). Se verificó una foto existente del usuario con Supabase Storage y
PostgreSQL reales: carga, duplicado y descarga idéntica por SHA-256 desde NestJS
local y desde Render. Ver [resultados de Render](evidence/m04-real-storage-render-20261106.json)
y [validación](validation.md). Los conectores comerciales y el análisis de
documentos siguen pendientes.

## Flujo de uso: automático, manual y pendiente

- **Automático hoy:** M02 verifica el webhook de captura de PayPal; M03 persiste
  el pago y vincula el pedido disponible. M04 guarda los registros estructurados
  de pago/pedido y sus referencias mediante su interfaz pública. Captura de pago
  significa confirmación del cobro, no captura de pantalla.
- **Aportado hoy por el comerciante:** los documentos PDF/PNG/JPEG se cargan por
  las rutas autorizadas de M04. Tracking y entrega se registran con procedencia
  explícita. La prueba de Storage utilizó un archivo existente del usuario,
  conservado sin cambios; no se obtuvo automáticamente desde PayPal o un carrier.
- **Flujo completo previsto:** los conectores de tienda, facturación y paquetería
  aportarán documentos y eventos a M04. M05 buscará lo que falte y M06 revisará
  las fuentes. El usuario intervendrá para documentos faltantes, fuentes sin
  conectar y contradicciones; no debería tener que cargar toda la evidencia.

El almacenamiento privado ya funciona y está desplegado. La recolección
automática de archivos desde esas fuentes comerciales todavía no está
implementada. No se generan capturas, facturas o comprobantes ficticios para
sustituir originales. El frontend que permitirá operar estas rutas vive aparte.

La rama funcional del módulo es `feat/m04-evidence-vault`. El incremento de
archivos se desarrolló en `feat/m04-private-evidence-files` y se integró por
PR #11; la rama funcional conserva también la documentación de su verificación.

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
- `uploadFile(tx, context, input, actorUserId)`: valida y conserva un original
  privado; registra metadatos y una revisión solo si Storage confirma los bytes.
- `downloadFile(tx, context, evidenceId)`: recupera una versión autorizada y
  compara tamaño y SHA-256 antes de devolver los bytes.

Las claves foráneas compuestas impiden asociar un pedido o expediente a una
transacción de otro merchant. Las tres tablas nuevas tienen RLS sin políticas
públicas. Solo el backend autorizado accede a datos de evidencia.

## Registros, procedencia e integridad

Tipos: `PAYMENT_RECORD`, `ORDER_RECORD`, `TRACKING`, `PROOF_OF_DELIVERY`, `DOCUMENT`.
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
En `DOCUMENT`, `contentHash` e `integrity` corresponden a los metadatos JSON.
`content.sha256` corresponde a los bytes originales. Listar el expediente no
consulta Storage: la integridad binaria se comprueba al cargar y descargar.

## Readiness y revisiones

El evaluador comprueba identidad, hashes, fechas y coherencia de un paquete.
Tracking de otro paquete, entrega anterior al envío/pedido, envío cancelado,
pedido contradictorio o contenido alterado impiden `READY`. Una entrega
`RETRACTED` vuelve a faltar aunque el registro anterior siga en el historial.
`containsDemo=true` advierte si el pedido o evidencia vigente incluye simulaciones.

`READY` significa cobertura estructurada. La evaluación semántica e independiente
de fuentes corresponde al futuro M06, y el permiso de envío corresponde a M08.
Un archivo `DOCUMENT` no sustituye tracking ni prueba estructurada de entrega.
Metadatos de archivo alterados o inválidos provocan `NEEDS_REVIEW` con motivo
`EVIDENCE_FILE_METADATA_INVALID`. Los archivos DEMO también activan `containsDemo`.

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

## Archivos privados

- `POST /api/transactions/:id/evidence/files`: ADMIN; JSON con procedencia,
  `fileName`, `mediaType` y `dataBase64`. Devuelve `EvidenceReceipt`, HTTP 201,
  con `CREATED` o `DUPLICATE` y el ID de la versión. Se puede adjuntar un archivo
  a una captura autorizada aunque todavía no exista pedido comercial.
- `GET /api/transactions/:id/evidence/files/:evidenceId`: ADMIN/VIEWER del
  merchant; permite descargar versiones anteriores. Devuelve bytes con
  `Content-Disposition: attachment` y `Cache-Control: private, no-store`.
  No expone URLs firmadas ni credenciales de Storage.

Ejemplo de carga desde Node.js, usando un PDF real elegido por el comerciante:

```js
const body = {
  sourceKind: 'MERCHANT_INPUT',
  sourceSystem: 'merchant-documents',
  externalReference: 'DOCUMENT-001',
  retrievedAt: new Date().toISOString(),
  fileName: 'receipt.pdf',
  mediaType: 'application/pdf',
  dataBase64: bytes.toString('base64'),
};
// POST con el JWT del ADMIN; bytes es el Buffer del archivo elegido.
```

Límite: 512 KiB decodificados por archivo, compatible con el límite HTTP de 1 MiB
incluyendo base64. Solo PDF, PNG y JPEG. Se valida base64 canónico, tamaño y
firma inicial del formato; no se interpreta el documento ni se certifica que
sea auténtico, esté libre de malware o demuestre una entrega. No se ejecuta su
contenido. El nombre solo admite caracteres ASCII seguros y no determina la ruta.

Configurar `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (solo backend) y
`EVIDENCE_BUCKET=private-evidence`. Aprovisionar previamente un bucket privado,
sin políticas públicas de lectura/escritura, con límite de 524288 bytes y MIME
permitidos `application/pdf`, `image/png`, `image/jpeg`. La API comprueba que el
bucket sea privado en cada operación. No lo crea ni cambia su configuración.
La orden administrativa `pnpm storage:setup` crea el bucket privado si falta,
con esos límites. Es idempotente y rechaza un bucket público existente sin
alterar su configuración. No se ejecuta automáticamente al arrancar la API.
La clave actual `sb_secret_...` se envía solo en `apikey`; se admite
`SUPABASE_SERVICE_ROLE_KEY` como fallback legado JWT si no está definida la clave
actual. Si se configuran ambas, tiene prioridad `SUPABASE_SECRET_KEY`.
Sin configuración responde 503; Storage inaccesible o con fallos responde 502;
hash/tamaño alterados, 409. No se registran respuestas, cuerpos o claves remotas.

Las claves son `merchantId/transactionId/sha256`. La carga no sobrescribe objetos;
un objeto existente solo se acepta tras leer y verificar su hash. El mismo
contenido y fuente devuelve la versión vigente; una corrección agrega versión.
La procedencia no puede pasar de DEMO a real para una misma fuente. La migración
`20261106030000_evidence_documents` amplía la restricción de tipos y prohíbe
documentos etiquetados como PayPal desde la base de datos.
La séptima migración `20261106040000_evidence_document_provenance` extiende
también la restricción por tipo/procedencia que existía en la base desplegada.
Pedidos, tracking, entregas y documentos admiten solo MERCHANT_INPUT/DEMO;
PAYMENT_RECORD exige PAYPAL. No se debilitan las restricciones existentes.

Storage y PostgreSQL no comparten una transacción distribuida: un fallo de Storage
revierte metadatos/revisión; un fallo de commit o un timeout después de escribir
puede dejar un objeto privado sin referencia. Reintentar con los mismos bytes
reutiliza el objeto. No se borran objetos automáticamente ni se implementa aún
recolección de huérfanos. Mantener estable el proyecto y bucket; cambiar su
ubicación requiere migrar los originales. No hay borrado ni edición de versiones
por HTTP. La clave service role debe mantenerse fuera de clientes y Git.

El adaptador usa las operaciones de [carga estándar de Supabase](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
y [descarga autenticada de buckets privados](https://supabase.com/docs/guides/storage/serving/downloads).

# Originales de fuentes conectadas

`ORDER_SOURCE_RECORD` conserva la respuesta original del adaptador y su
normalización, con origen `PAYPAL` o `CONNECTED_SYSTEM`, versiones y SHA-256.
`ORDER_RECORD` conserva cada fuente por separado; no reemplaza registros DEMO
ni certifica envío/entrega. Ver [fuentes de pedidos](order-information-sources.md).
