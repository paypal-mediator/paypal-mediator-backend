# Cola ERP y pg-boss

## Corrección del 12 de noviembre de 2026

`IntegrationsService` registra y espera el handler `ERP_SYNC` antes de conectar.
`JobsService` utiliza los tipos publicados por pg-boss y crea cada cola antes de
iniciar su worker. Solo informa conexión activa después de completar el arranque
y las suscripciones; los intentos concurrentes comparten el arranque. Un fallo
detiene la instancia parcial y permite volver a intentar `connect()`.

Cada payload debe incluir un `merchantId` UUID. Los eventos de finalización y
fallo se guardan bajo ese merchant; el procesamiento ERP tampoco usa un merchant
global ficticio. Los errores de auditoría no convierten trabajos en éxitos y, si
falla además la auditoría de un error del handler, se conserva el error original.
Los logs de infraestructura contienen códigos constantes, sin conexiones ni
payloads. Se eliminó el filtro global de tests que ignoraba errores de conexión
y claves foráneas.

Las opciones internas `retries`, `delay` y `ttl` se traducen a `retryLimit`,
`startAfter` y `expireInSeconds`. Delay y timeout entran en milisegundos; pg-boss
recibe segundos y el timeout se redondea hacia arriba. Un `send()` sin ID es un
fallo, nunca una confirmación de encolado.

`POST /api/integrations/:connectionId/sync` devuelve 503 si la cola está ausente.
Si falla un encolado, persiste `ERP_ENQUEUE_FAILED` y devuelve 503 indicando que
no se pudo encolar la solicitud completa. Los trabajos ya aceptados pueden
continuar: no se promete atomicidad entre varios recursos ni rollback de sus
efectos. El estado `syncing` se escribe antes del primer envío, para no
sobrescribir la finalización de un worker rápido.

Solo se aceptan recursos implementados por el adaptador: pedidos, facturas y,
cuando existen sus métodos, envíos y pagos. Pedir clientes, documentos u otro
recurso no implementado devuelve 400 en lugar de éxito vacío. Esto no completa
los conectores externos, la paginación automática ni un seguimiento agregado de
todos los recursos de una sincronización.

## Verificación

- Unitarias: `apps/api/test/unit/jobs.spec.ts` e `integrations-sync.spec.ts`, con
  pg-boss/base de datos MOCK explícitos, cubren arranque, recuperación, auditoría,
  opciones, rechazos y fallos parciales.
- PostgreSQL: `apps/api/test/integration/jobs.db.spec.ts` usa la composición NestJS
  real, cifrado de credenciales, pg-boss y auditoría persistente. MockERP está
  etiquetado como MOCK; no llama a proveedores comerciales. Comprueba registros,
  finalización de jobs, fallos, merchant y opciones guardadas.
- Ejecutar `pnpm check`, las migraciones existentes con `pnpm db:deploy` y
  `pnpm test:db` sobre una base desechable indicada por `TEST_DATABASE_URL`.
  No se requieren cambios de schema para esta corrección.

Validación local ejecutada el 12 de noviembre: `pnpm check` con 389 pruebas,
19 migraciones aplicadas y repetidas en PostgreSQL 18.6 desechable,
`pnpm test:db` con 169 pruebas y `pnpm test:mediation` con 162 pruebas y
cobertura de 91,46% de líneas y 82,62% de ramas. Las suites de mediación se
solapan con las anteriores; los conteos no deben sumarse. No se hicieron
llamadas comerciales a ERP, PayPal o LLM para esta corrección.

El frontend permanece en su repositorio. `.gitmodules` permite recuperar la
referencia ya versionada mediante `git submodule update --init`. El build y el
despliegue del backend no compilan ni publican ese frontend.
