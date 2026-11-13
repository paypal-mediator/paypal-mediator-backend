# Asociar pagos PayPal con registros Odoo

Publicado en Render con `9bcd974`, migración aplicada y API real verificada.
La instancia conectada sigue vacía: se muestra UNRESOLVED sin crear vínculos.
Ver [despliegue y evidencia](deployment.md#asociación-odoo-publicada--13-de-noviembre-de-2026).

## Flujo

M03 registra Odoo como fuente de pedidos junto con PayPal. Integrations conserva
la propiedad de conexiones, registros importados y `transaction_links`; M03
los consume mediante la interfaz pública `OdooRecordsService` y conserva su
propio `OrderSourceJob`. M04 recibe originales por su interfaz de evidencia.
No se escriben tablas privadas de otro módulo directamente.

Después de importar registros mediante **Sync now**, el worker existente de M03
crea trabajos ODOO para capturas anteriores y nuevas del mismo equipo. Revisa
los trabajos cada minuto; la acción ADMIN
`POST /api/transactions/:id/refresh-order-sources` permite solicitar una revisión
inmediata. La importación desde Odoo continúa dependiendo de pg-boss y de los
permisos de la instancia; la asociación lee la copia importada, no inventa datos
cuando la cola o la API no están disponibles.

## Referencias que permiten asociar

- `custom_id` del pago coincide exactamente con el número del pedido Odoo o su
  `client_order_ref`.
- `invoice_id` coincide con el número de factura Odoo.
- El ID de captura, ID de orden PayPal o referencia comercial coincide con una
  referencia explícita del registro, por ejemplo `memo` de un pago Odoo.
- Una vez identificado un registro, se siguen relaciones del **mismo equipo,
  conexión y compañía**: `invoice_ids` del pedido, origen de factura, referencia
  del pago y origen del envío. No se cruzan IDs numéricos de distintas instancias.

No se asocia por nombre de cliente, correo, fecha o importe parecido. Los
importes y moneda de los registros que identifican directamente al pago deben
coincidir. Dos pedidos o instancias candidatos, referencias contradictorias,
monedas/importes diferentes o hashes alterados impiden confirmar el vínculo.
Los candidatos quedan en el snapshot para revisión; no se elige uno al azar.

Para que exista el enlace, el checkout o el registro Odoo debe conservar una
referencia común real. Esta integración no crea pedidos, facturas, capturas ni
referencias artificiales en Odoo, y no demuestra quién creó un checkout externo.

## Datos y documentos

La sincronización incorpora referencias del cliente, líneas del pedido,
relaciones de facturas, moneda/importes y la fecha real de salida del almacén.
El cursor combina `write_date` e ID para no perder registros con la misma fecha;
las páginas siguientes se encolan hasta terminar. Un fallo al encolar la
continuación queda explícito y no se presenta como sincronización completa.

`orderEnrichment.records[].data` expone `relatedRecords` con el pedido, facturas,
pagos y envíos asociados, método y conexión, y `documentImport` con el resultado
de los originales. Las asociaciones también se consultan en
`GET /api/integrations/transactions/:captureId/linked-records`.
El expediente utiliza primero un pedido completo; PayPal conserva prioridad
cuando ambas fuentes tienen la misma cobertura. Las discrepancias entre fuentes
siguen requiriendo revisión.

Solo tras una asociación inequívoca se buscan adjuntos `ir.attachment` que
pertenezcan a los pedidos, facturas o envíos confirmados. Se leen por ID en la
misma instancia autenticada y se vuelve a comprobar padre, fecha, tamaño y
contenido. No se descargan URLs suministradas por los documentos.

Por revisión se admiten hasta tres PDF/PNG/JPEG, cada uno de hasta 512 KiB. Las
respuestas Odoo tienen un límite de 1 MiB. Se conservan bytes originales en
Storage privado, hash SHA-256, origen `CONNECTED_SYSTEM` y referencia del adjunto.
No se generan PDF ni se llama a acciones de impresión/envío para sustituir un
original inexistente. Documentos ausentes, no permitidos o inaccesibles quedan
indicados como faltantes; un fallo de Storage revierte vínculos y metadatos.

Una salida Odoo con estado done es información de envío, **no prueba de entrega
al comprador**. Adjuntar una factura no completa tracking o entrega por sí solo.
La lectura de archivos mantiene JWT, membresía por equipo e integridad binaria.
El contrato público de carga sigue rechazando procedencia PayPal/CONNECTED_SYSTEM
aportada por el navegador.

La confirmación revalida los hashes de origen y bloquea conexión/registros en
orden consistente antes de guardar los vínculos dentro de la unidad de trabajo
de M03/M04. La desconexión elimina sus registros importados y vínculos, conserva
la evidencia histórica y permite que M03 deje de utilizar la fuente actual.

## Migración y límites comprobados

Aplicar `20261113030000_odoo_evidence_documents`: amplía únicamente las dos
restricciones de procedencia de M04 para admitir originales de conectores.
No cambia el schema Prisma ni abre acceso público a las tablas.

PostgreSQL/HTTP con Odoo, PayPal, identidad y Storage MOCK cubre sincronización,
asociación exacta/relacional, original descargado idéntico, idempotencia,
aislamiento, ambigüedad, importe contradictorio, alteración de hash, fallo de
Storage, backfill, polling, selección de pedido completo y desconexión. Las
pruebas de adaptador cubren paginación con fechas iguales, límite de respuesta,
errores sanitizados y rechazo de adjuntos ajenos.

Validación local ejecutada: `pnpm check` (434 pruebas y build), 24 migraciones
aplicadas y repetidas en PostgreSQL desechable y `pnpm test:db` (221 pruebas)
aprobados. Estos totales incluyen las invitaciones M01 locales, conservadas
fuera de este incremento y de su commit.

Lectura Odoo real del 13 de noviembre: pedidos, facturas, pagos y envíos devolvieron
cero registros. La primera lectura de facturas recibió 429; se reintentó sola y
respondió correctamente sin datos. No se crearon ni modificaron registros Odoo.
Esto acredita acceso de lectura con los campos nuevos, **no una asociación ni
importación de documentos reales**. Ver [evidencia](evidence/odoo-association-read-20261113.json).

Fuentes oficiales: [JSON-2 Odoo 19](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)
y [modelo de adjuntos Odoo](https://github.com/odoo/odoo/blob/19.0/odoo/addons/base/models/ir_attachment.py).
