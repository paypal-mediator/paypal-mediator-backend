# Backend público y webhook PayPal

## Asociación Odoo publicada — 13 de noviembre de 2026

Commit `9bcd974` enviado a main y confirmado Live en Render, despliegue
`dep-dbrc6uh42hec73bepk1g`, terminado a las 08:01:22 UTC. La migración
`20261113030000_odoo_evidence_documents` se aplicó al arranque; una consulta
independiente con TLS/CA/hostname verificados confirmó su finalización y que
la instancia Odoo conectada al equipo de prueba tiene cero registros importados.

La lectura real de pedidos, facturas, pagos y envíos también devolvió cero.
La primera consulta de facturas recibió 429 y una repetición individual respondió
sin datos. No se modificó Odoo ni se crearon documentos o movimientos financieros.
La API publicada con Supabase Auth real muestra la fuente ODOO del pago Sandbox
existente, estado PARTIAL, asociación UNRESOLVED y motivo
`ODOO_EXACT_REFERENCE_NOT_FOUND`, cero registros/enlaces y documentos no
solicitados. Readiness responde 200/PostgreSQL up y sin sesión se obtiene 401.
Esto valida la publicación y el tratamiento honesto de una instancia vacía;
la asociación y los adjuntos con datos se validaron con proveedores MOCK y
PostgreSQL real. El error previo de enriquecimiento del pedido PayPal
`PAYPAL_ORDER_HTTP_ERROR` se conserva y no se ocultó con la fuente nueva.

CI del commit aprobado: `pnpm check` (431 pruebas unitarias/HTTP), migraciones,
`pnpm test:db` (201) y `pnpm test:mediation` (162). Las cifras locales anteriores
434/221 incluían las invitaciones M01 aún sin commit; ese trabajo y el frontend
se conservaron fuera de este incremento. Ver [CI](https://github.com/paypal-mediator/paypal-mediator-backend/actions/runs/43389771649),
[evidencia publicada](evidence/odoo-association-render-20261113.json) y
[contrato y operación](odoo-payment-association.md).

## M02/M03 publicados y eventos registrados — 13 de noviembre de 2026

Código `852628a` enviado a `main` junto con `b470806`. Render confirmó Live
para `852628a3f8b1cff838e47b4f45663535e1482627`, despliegue
`dep-dbrbeh49v7es73a1f7vg`, terminado a las 07:08:51 UTC. El servicio usa
`pnpm start:render`; la migración `20261113020000_payment_adjustments` quedó
aplicada. Consulta independiente por TLS con CA y hostname verificados confirmó
la migración finalizada, RLS en `payment_adjustments` y NUMERIC(38,8) para el
total devuelto. La migración local de invitaciones M01 no se publicó ni aplicó.

PayPal Sandbox: webhook `6D45716373290850N`, dirigido a
`https://paypal-mediator-backend.onrender.com/api/webhooks/paypal`. Se añadieron
`PAYMENT.CAPTURE.REFUNDED` y `PAYMENT.CAPTURE.REVERSED` mediante la API oficial;
una lectura posterior confirmó los siete eventos, conservando capturas,
disputas y revocación de consentimiento. Se usó la configuración efectiva de
Render, sin cambiar credenciales ni iniciar movimientos de dinero.

API publicada con Supabase Auth real: readiness 200/PostgreSQL up, listado de
trabajos y salud M02 por equipo 200, transacciones 200 con `financialSummary`.
Sin sesión, salud M02 devuelve 401. El equipo Sandbox conectado conservó su
captura existente y no tenía trabajos pendientes o fallidos en esta comprobación.
No se ejecutó un reembolso/reversión real ni se afirma una entrega financiera
firmada nueva; la lógica financiera se cubre con PayPal MOCK/PostgreSQL real.

CI del commit publicado aprobado: `pnpm check` (427 pruebas unitarias/HTTP),
migraciones, `pnpm test:db` (194) y `pnpm test:mediation` (162). Un checkout
limpio local del commit también aprobó `pnpm check` y build. Los conteos son
menores que los del workspace anterior porque excluyen los cambios M01 locales
que aún no tienen commit. Ver [CI](https://github.com/paypal-mediator/paypal-mediator-backend/actions/runs/43383518492)
y [evidencia sin secretos](evidence/m02-refunds-render-20261113.json).

## Chat de conciliación publicado — 12 de noviembre de 2026

Render confirmó `live` para backend `d728506` (despliegue `dep-dbr6olu8bjmc73beib1g`) y frontend `719e226` (`dep-dbr6omh42hec73b8pd40`). La migración `20261112020000_preventive_conciliations` se aplicó en Supabase mediante Prisma con TLS verificado; las tres tablas tienen RLS habilitado. Se conservaron dos entradas históricas adicionales de migración de la base, sin reescribirlas ni resetear datos.

API real: readiness 200, acceso sin sesión 401, fuente de pedido privado identificada, acuse positivo sin borrador, NLP local y generador real con borrador privado, publicación del texto editado e idempotencia. Navegador Chrome de pruebas contra frontend/API publicados, sin mocks: comprador móvil, envío y recarga, lista con búsqueda/filtros, navegación al chat independiente, recarga/regreso y ajustes del equipo. Pedido y mensajes de comprador explícitamente DEMO; no se hizo ningún pago ni se contactó a compradores reales. Se resolvió/revocó el chat DEMO y se revocó el enlace adicional de prueba de un pago Sandbox con datos importados.

Validación local: `pnpm check` (411 pruebas), migraciones aplicadas/repetidas en PostgreSQL desechable y `pnpm test:db` (183); frontend con 39 pruebas, lint, tipos y build. La activación de asistencia permanece en ajustes del equipo. La procedencia de la información distingue PayPal/ERP de pedidos manuales, pero el checkout originador sigue sin verificar: no se insertan automáticamente enlaces en recibos PayPal. También se observó HTTP 500 en `/api/activity`, que produce un aviso de notificaciones independiente de la conciliación.

Ver [evidencia publicada](evidence/conciliations-render-20261112.json) y [flujo y límites](preventive-conciliations.md).

## Servicio creado el 11 de noviembre de 2026

El workspace `My Workspace` contiene `paypal-mediator-backend` en Oregon,
con URL <https://paypal-mediator-backend.onrender.com> y despliegue automático
desde `main`. Su comando de build es `pnpm install --frozen-lockfile && pnpm run build`.
El script `build` genera el cliente Prisma antes de compilar: el cliente generado
no se versiona y no existe en un checkout limpio. Omitir este paso causa errores
TS2307 de `generated/prisma/client.js` y errores derivados en `PrismaService`.

El comando de arranque configurado es `pnpm run start`; las migraciones requieren
`pnpm db:deploy` por separado o configurar `pnpm start:render` como arranque.
La configuración y las comprobaciones históricas siguientes corresponden al
servicio anterior y no acreditan la disponibilidad de este servicio nuevo.

## M09 publicado y verificado — 7 de noviembre de 2026

PR #16 integrado en `main` (`65bd498`); CI aprobó check (191 pruebas) y
PostgreSQL (95). Render publicó las rutas autenticadas `/api/activity` y
`/api/activity/metrics`, ambas HTTP 200. Las migraciones de auditoría y métricas
están aplicadas en Supabase. Nuevo pago Sandbox de 1 USD ficticio aprobado por
el asistente en Opera GX/CDP 9223, webhook genuino y flujo remoto M01–M06/M09.
M06 terminó REJECTED; los fallos posteriores M05 permanecen registrados. No
hubo envíos ni se utilizaron M07/M08. Política original restaurada.
Ver [alcance M09](m09-monitoring.md) y
[evidencia live](evidence/m09-m01-m06-sandbox-20261107.json).

## M05/M06 publicados — 7 de noviembre de 2026

PR #14 integrado en main, commit f4be534. CI aprobó pnpm check con 189 pruebas
unitarias/HTTP, migraciones y 88 pruebas PostgreSQL. Implementation.md está
versionado. Render publicó automáticamente después de CI.

Readiness, merchant, transacción y resultados M05/M06 autenticados devuelven HTTP
200; M06 sin sesión devuelve 401. El resultado real permanece INCOMPLETE, vigente,
con ocho dimensiones y submissionAuthorized=false. Los GET publicados sustituyen
los 404 observados antes del despliegue.

**Configuración completada:** NVIDIA_API_KEY se configuró desde el .env local en
Render mediante Opera GX/CDP expresamente autorizado, sin mostrar el secreto ni
guardarlo en Git. AI_PROVIDER=nvidia y NVIDIA_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b.
Save and deploy terminó Live, despliegue dep-dbndf99srm7s7394j3dg del commit f4be534.
Los POST M05/M06 pasaron de 503 a 201 y devolvieron los IDs originales por
idempotencia. No se hizo otra inferencia ni se generó otro cobro de PayPal.
La inferencia NVIDIA real está verificada localmente; la comprobación publicada
recuperó resultados existentes. Alternativa OpenAI: configurar
AI_PROVIDER=openai, OPENAI_API_KEY y OPENAI_MODEL, sin fallback automático.

La migración M06 ya está aplicada en Supabase. La prueba de lectura/idempotencia
restauró allowInvestigations=false; envíos deshabilitados y aprobación humana
obligatoria. La API publicada y el panel Live de Render confirmaron el despliegue.

Evidencia: [verificación publicada](evidence/m05-m06-render-20261107.json).

## Servicio del proyecto

- API: <https://resolve-ai-api-ybmj.onrender.com/api>.
- Readiness: <https://resolve-ai-api-ybmj.onrender.com/api/health/ready>.
- Webhook Sandbox: <https://resolve-ai-api-ybmj.onrender.com/api/webhooks/paypal>
  (solo POST; abrirlo en el navegador no genera una entrega).
- Render: `resolve-ai-api`, plan Free, Virginia, rama `main`.

La ampliación de órdenes comerciales y base M04 está publicada por PR #8
(`5dfae91`, implementación `bd8857c`). Hay cinco migraciones aplicadas en Supabase.
El nuevo pago Sandbox `2D098449XH6131418` recorrió M01/M02/M03 exclusivamente en
Render y produjo un expediente versionado. Pedidos, tracking y entrega de esa
prueba están etiquetados DEMO. Ver [validación completa](validation.md).

Historial del primer incremento: PR #6 (`ff12287`, implementación `6c3302c`). Verificado
el 6 de noviembre de 2026 a las 14:40 UTC: readiness HTTP 200, listado filtrado
y detalle de la captura `7HV195624A539251X` HTTP 200 con JWT real Supabase;
acceso sin sesión HTTP 401. El worker local temporal se detuvo antes de verificar
las rutas públicas. En esa fase había cuatro migraciones aplicadas. El worker de
capturas está habilitado por defecto en producción; ver la variable descrita abajo.

El 6 de noviembre de 2026 se publicó el servicio y se registró la suscripción
en la app PayPal Sandbox con los cuatro eventos descritos abajo. Se verificaron
readiness y acceso ADMIN con un JWT real de Supabase, además de OAuth y lectura
de disputas de PayPal desde Render. Después se capturó un pago Sandbox de
1 USD ficticio: su evento firmado se verificó y persistió en Supabase junto
con un trabajo `TRANSACTION_CAPTURED` en estado `QUEUED`. Ver los identificadores
y el alcance de la prueba en [validación](validation.md).

## Configuración

El incremento de archivos M04 está desplegado por PR #11 (`f49fd6c`). Requiere la sexta migración
`20261106030000_evidence_documents` y la séptima
`20261106040000_evidence_document_provenance`, `SUPABASE_SECRET_KEY` como secreto
solo del backend y `EVIDENCE_BUCKET` apuntando a un bucket privado previamente
aprovisionado. Ver [configuración y límites de archivos](m04-evidence.md#archivos-privados).
El bucket y ambas migraciones ya se aprovisionaron en Supabase. Una foto existente
del usuario recorrió carga y descarga por NestJS local y por Render con Storage
real y SHA-256 idéntico. Ver [validación](validation.md) para los resultados HTTP.

Render publica el backend NestJS como Web Service con HTTPS. `render.yaml`
describe un servicio Free en Virginia; usa Node 24, el lockfile pnpm y el
build de contratos/API. `npm run start:render` aplica migraciones existentes y
arranca el código compilado. El backend escucha en `0.0.0.0` y utiliza `PORT`
proporcionado por Render. Swagger se desactiva en el entorno publicado.

## Variables y certificado

Configurar en Render únicamente las variables requeridas por el servicio,
sin subir `.env`, contraseñas de usuarios ni credenciales de aprovisionamiento.
Las variables secretas del Blueprint usan `sync: false`.

- `DATABASE_URL` y `DIRECT_URL`: session pooler de Supabase con TLS verificado.
- `SUPABASE_URL`, `MERCHANT_ID`: el proyecto y merchant ya provisionados.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: app Sandbox del merchant.
- `PAYPAL_WEBHOOK_ID`: ID de la suscripción real registrada para este endpoint.
  Puede permanecer vacío durante el primer despliegue; la ingesta falla cerrada.
- `CORS_ORIGIN`: origen del frontend; para desarrollo puede ser
  `http://localhost:3000`, aunque la API esté publicada.
- `TRANSACTION_WORKER_ENABLED=true`: consumidor M03 de capturas verificadas.
  El código lo habilita por defecto en producción cuando la variable no está
  definida; un `false` explícito lo desactiva. Requiere `MERCHANT_ID` y las
  migraciones aplicadas. M07 hereda este flag salvo que se defina
  `DISPUTE_WORKER_ENABLED`; su migración `20261106070000_disputes` solo debe
  aplicarse cuando las migraciones de M05/M06 estén integradas en la misma rama.

Agregar en Environment → Secret Files el certificado oficial de Supabase con
nombre `supabase-ca.crt`. En las URLs de PostgreSQL reemplazar la ruta local
de `sslrootcert` por `/etc/secrets/supabase-ca.crt` y conservar
`sslmode=verify-full`. Las rutas Windows del `.env` local no sirven en Render.
Los valores y certificados se configuran en el Dashboard, no en el repositorio.

El plan Free no dispone de pre-deploy command; las migraciones se ejecutan al
arrancar, con las dependencias de desarrollo instaladas para disponer de Prisma
CLI. Si una migración falla no se inicia la API. Al crecer a varias instancias,
trasladar migraciones a una fase de release independiente.

## Registro PayPal

1. Confirmar HTTP 200 en `/api/health/ready` de la URL asignada por Render.
2. Registrar `https://<servicio>.onrender.com/api/webhooks/paypal` en la misma app
   PayPal Sandbox del merchant.
3. Suscribir `PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`,
   `CUSTOMER.DISPUTE.UPDATED` y `CUSTOMER.DISPUTE.RESOLVED`.
4. Guardar el ID de la suscripción en `PAYPAL_WEBHOOK_ID` en Render y localmente,
   y reiniciar/desplegar para aplicar el cambio.
5. Comprobar una entrega real en PayPal y las filas `WebhookEvent`/`IngestionJob`.

El simulador de PayPal genera eventos MOCK que no son equivalentes a una
entrega real y no admiten la verificación de firma postback usada por M02.
No desactivar la firma para conseguir una respuesta exitosa del simulador.
Una entrega real puede proceder de una operación Sandbox o del reenvío de un
evento genuino existente de esa app; nunca presentar un fixture como real.

El plan Free puede suspender el proceso por inactividad. PayPal reintenta
entregas sin respuesta exitosa, pero una demo con disponibilidad continua puede
necesitar un plan de pago elegido expresamente por el equipo.

Referencias: [Render Web Services](https://render.com/docs/web-services),
[secret files](https://render.com/docs/configure-environment-variables),
[simulador PayPal](https://developer.paypal.com/api/rest/webhooks/simulator/).
