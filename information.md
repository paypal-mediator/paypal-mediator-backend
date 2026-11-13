# ResolveAI — estado vigente del backend

Actualizado el **13 de noviembre de 2026** a partir del código del workspace,
las guías de cada módulo y las evidencias de despliegue ya registradas.
Implementado localmente, publicado y probado con proveedores reales son estados
distintos. La publicación M07/M08 se verificó después de las pruebas locales.

El contexto anterior se conserva como [historial](docs/information-history-20261113.md).
Sus fechas, tecnologías propuestas, checklists y pendientes antiguos no sustituyen
este estado. Las guías específicas conservan también notas históricas fechadas.

**Publicación M07/M08 verificada:** commit `322eff4`, Render Live
`dep-dbrljpbm8hqs739kcaug`. Las cuatro migraciones aparecen aplicadas en los logs
de arranque; readiness 200/PostgreSQL up y lecturas autenticadas de disputas y
actividad M08 200. Sin sesión, la ruta nueva de investigación devuelve 401.
Ver [evidencia publicada](docs/evidence/m07-m08-render-20261113.json).
El ciclo real de disputa y presentación PayPal continúa pendiente.
CI del commit publicado aprobado: 459 pruebas unitarias/HTTP, 215 PostgreSQL,
162 de mediación y repetición de migraciones sin pendientes.
Ver [CI](https://github.com/paypal-mediator/paypal-mediator-backend/actions/runs/43485103612).

## Producto y reglas

ResolveAI prepara expedientes de pagos PayPal y ayuda al vendedor a investigar
y responder disputas abiertas por el comprador en PayPal. La preparación
documental no representa probabilidad de ganar. PayPal decide el resultado oficial.

- Backend único NestJS modular. El frontend está en otro repositorio; la referencia
  anidada `paypal-mediator-frontend` no forma parte del build de esta API.
- Node 24, TypeScript/ESM, pnpm, Prisma 7 y PostgreSQL. Supabase proporciona
  Auth/JWKS y Storage privado. Los agentes admiten NVIDIA/OpenAI; NVIDIA tiene
  evidencia previa de ejecución real y OpenAI está cubierto con MOCK.
- NLP.js local clasifica las conversaciones preventivas antes de invocar al
  generador. La cola de ingesta M02 es PostgreSQL; pg-boss es una cola opcional
  independiente para trabajos ERP.
- Código en `apps/api/src`, pruebas en `apps/api/test`, Prisma en
  `apps/api/prisma`, contratos Zod en `packages/contracts` y guías en `docs`.
- Leer este archivo y [arquitectura](docs/architecture.md) antes de implementar.
  Cada módulo conserva sus tablas; las interacciones usan interfaces públicas.
- No versionar secretos, `.env`, builds ni el cliente Prisma generado.
  DEMO/MOCK se identifican como tales. No inventar pagos, documentos ni éxitos.
- Los agentes no pueden llamar directamente al envío de evidencia. Se mantienen
  políticas del equipo, autorización y controles deterministas del servidor.
- Ejecutar `pnpm check`. Si cambia persistencia, aplicar y repetir migraciones
  y ejecutar `pnpm test:db` contra PostgreSQL desechable.

## Estado por módulo

| Módulo | Implementado actualmente | Límite o pendiente vigente |
| --- | --- | --- |
| M01 — Merchant & Integrations | JWT Supabase/JWKS, membresías ADMIN/VIEWER, equipos e invitaciones por correo verificado, selección con `X-Merchant-Id`, políticas y conexión PayPal Sandbox por negocio. Invitaciones con aceptación/rechazo, revocación, vencimiento, enlace compartible y outbox Resend/SMTP. | El correo requiere proveedor y remitente configurados; SENT solo confirma aceptación del proveedor. Datos adicionales del wizard y prueba de dos vendedores PayPal reales aislados pendientes. Ver [invitaciones](docs/team-invitations.md). |
| M02 — Event Ingestion | Firma oficial PayPal, cuerpo original, deduplicación, eventos/trabajos transaccionales, salud y recuperación ADMIN por equipo. Capturas, disputas, consentimiento y ajustes financieros. | Falta entrega firmada real nueva de REFUNDED/REVERSED y ciclo genuino de disputa. |
| M03 — Transaction Manager | Capturas, pedidos, readiness, fuentes Orders v2/Odoo, reembolsos/reversiones persistentes, saldo y revisión de inconsistencias. | La instancia Odoo consultada no tiene registros; asociación con datos reales pendiente. No inicia devoluciones. |
| M04 — Evidence Vault | Originales privados, hashes, versiones, documentos, expedientes y fuentes PayPal/Odoo. Storage real verificado previamente. | Datos y documentos Odoo reales pendientes; los proveedores incompletos no deben presentarse como conectores terminados. |
| M05 — Investigator | Investigación acotada, herramientas de lectura, borradores con citas, persistencia, idempotencia, recuperación y auditoría. | La prueba real previa terminó COMPLETED, pero faltaban pruebas de envío/entrega. No autoriza presentaciones. |
| M06 — Verifier | Revisión independiente de originales, ocho dimensiones, integridad, caducidad documental y revisión explícita de rechazos. Nuevo alcance publicado `DISPUTE_INR`, vinculado a una disputa M07 concreta; `PREVENTIVE_INR` permanece separado. | La aprobación preventiva nunca habilita M08. Revisión de disputa y envío externo siguen pendientes de prueba real. |
| M07 — Dispute Orchestrator | Ingesta `DISPUTE_CHANGED`, vinculación exacta por captura, aislamiento, conflictos, eventos fuera de orden, consultas y worker por equipos. Nuevo ciclo publicado M05 → M06 desde una disputa. | El ciclo nuevo ejecuta una ronda por solicitud; no es un workflow autónomo completo con todos los estados planeados. No se ha ejercido el ciclo real de una disputa Sandbox. |
| M08 — PayPal Submission | Guard, ADMIN, aprobación explícita, revisión M06 del caso y revisión documental vigente. Reserva persistente, idempotencia por solicitud, bloqueo de concurrencia, lectura fresca de acciones PayPal y resultado auditable. | Publicado en Render con 322eff4. El envío directo admite notas `OTHER` respaldadas por originales. Solicitudes de documentos específicos, adjuntos PayPal no revisados o contexto cambiado detienen el envío. Flujo real pendiente. |
| M09 — Monitoring & Audit | Auditoría transaccional append-only, actividad, filtros, métricas, pasos y resultados de agentes. Los nuevos eventos de presentación se clasifican M08. | Hubo un HTTP 500 remoto en `/api/activity`; no se da por resuelto sin reproducción/verificación. |
| M10 — Dashboard | Frontend separado publicado en Render, con transacciones, disputas, actividad, integraciones y conciliación preventiva según evidencias previas. | El frontend debe integrar el nuevo contrato de aprobación y mostrar PENDING/UNKNOWN. Este incremento no modifica ni valida ese repositorio. |

## M07 → M06 → M08: incremento publicado el 13 de noviembre

`POST /api/disputes/:id/investigate` exige ADMIN, una disputa INR abierta y
vinculada, políticas habilitadas y contexto coherente para M05. Recibe
`{ "idempotencyKey": "UUID" }`. Ejecuta una investigación y, si termina
COMPLETED y vigente, una revisión independiente del caso. Devuelve ambas
ejecuciones; `submissionAuthorized` permanece `false`. Un fallo de agente o
un cambio del caso no se convierte en un resultado aprobado ni dispara un envío.

La ruta existente de verificaciones de una investigación admite `disputeId`
opcional para solicitar la revisión concreta. M06 conserva ID, motivo, mensajes
y fecha del evento de la disputa dentro de su snapshot con hash. Su interfaz
pública de presentación exige la última verificación, COMPLETED/APPROVED,
fuentes actuales e íntegras, ausencia de DEMO, ocho PASS y afirmaciones respaldadas.
Cambiar la disputa o la revisión usando la misma clave produce conflicto.

`POST /api/disputes/:id/submit` exige ADMIN. Para autorizar el intento concreto:

```json
{
  "idempotencyKey": "UUID",
  "verificationId": "UUID de la revisión del caso",
  "approve": true
}
```

El servidor obtiene el caso mediante la interfaz pública de M07; las políticas
de M01, el pago de M03 y la revisión de M06 también se consultan por sus servicios.
M08 escribe únicamente sus intentos y auditoría mediante M09. No cambia el estado
oficial PayPal ni las tablas de otros módulos.

Estados de presentación:

- `BLOCKED`: guard rechazado antes de contactar PayPal; una solicitud corregida
  puede utilizar una clave nueva conservando el historial.
- `PENDING`: reserva persistida antes del envío. Otra solicitud no vuelve a enviar.
  Si el proceso se interrumpe, requiere revisión; no se libera automáticamente.
- `SUBMITTED`: entrega confirmada por PayPal, incluso con respuesta sin cuerpo.
- `FAILED`: preflight fallido antes de despacho; puede intentarse otra solicitud
  después de corregir la causa.
- `UNKNOWN`: fallo desde el despacho o confirmación incierta; bloquea nuevos
  envíos hasta conciliación manual con PayPal. No significa rechazo confirmado.

La clave queda ligada al equipo, disputa, actor, revisión y aprobación mediante
un hash. No se devuelven resultados de otro equipo. Locks transaccionales y un
índice único parcial impiden reservar dos envíos activos de la misma disputa.
Las migraciones nuevas son `20261113040000_submission_safety`,
`20261113050000_submission_audit` y
`20261113060000_submission_legacy_reconciliation` y
`20261113070000_submission_rls`. Esta última activa RLS en las dos tablas M08
sin políticas de acceso público. Los FAILED históricos sin
hash pasan a UNKNOWN porque el código anterior no distinguía rechazo de timeout
o respuesta exitosa no parseada; requieren conciliación antes de otro envío.

Antes del envío se vuelve a leer PayPal: acción `provide-evidence` presente,
estado de respuesta del vendedor, etapa, captura, motivo y mensajes coherentes.
El payload usa multipart con `evidences`, tipo `OTHER` y notas verificadas;
los UUID internos nunca se envían como supuestos IDs de evidencia PayPal.
Esta ruta no sustituye el expediente documental del módulo de mediación.

## Otras funciones existentes

- **Conciliación preventiva:** chat privado por pago/pedido independiente de
  disputas. Enlaces revocables, NLP bilingüe, borradores privados, aprobación
  editada y reglas opcionales con textos aprobados. La bandeja requiere un
  mensaje BUYER. No se inserta automáticamente el enlace en checkout/recibo
  PayPal. Ver [contrato](docs/preventive-conciliations.md).
- **Mediación de disputas:** módulo separado con políticas, agentes, revisión
  independiente M06, expedientes, reservas de entrega y acciones PayPal no
  financieras. Su implementación y pruebas locales no demuestran un envío
  real. Ver [mediación](docs/mediation.md) y [validación](docs/mediation-validation.md).
- **Odoo:** nuevas conexiones ERP solo Odoo, verificación real antes de cifrar,
  registros y asociaciones exactas por conexión. La consulta real registrada
  devolvió cero datos. Ver [asociación](docs/odoo-payment-association.md).
- **17TRACK:** respaldo PayPal → ERP → 17TRACK, opt-in, presupuesto y leases,
  webhooks firmados y snapshots. Sin API key no consulta ni simula éxito.
  Un evento de entrega no genera prueba documental. Ver [seguimiento](docs/shipment-tracking-17track.md).
- **Jobs/ERP:** pg-boss opcional tiene corregida su importación y arranque en
  el código actual, con pruebas de recuperación. El antiguo error `Boss is not
  a constructor` no debe listarse como fallo actual confirmado. Ver [guía](docs/jobs-and-erp-queue.md).
- **Billing:** catálogo y suscripciones locales; no acredita cobros ni una
  integración financiera de facturación.

## Publicación y evidencia externa existente

Backend: `https://paypal-mediator-backend.onrender.com/api`.
Frontend: `https://paypal-mediator-frontend.onrender.com`.
Las URLs anteriores resolve-ai-api/Vercel que aparecen en el historial son
referencias antiguas. La publicación y la configuración CORS se documentan en
[despliegue](docs/deployment.md). El frontend tiene repositorio y ciclo propios.

Se han documentado previamente Auth/PostgreSQL/Storage reales, OAuth PayPal,
pagos Sandbox ficticios capturados, webhooks genuinos de captura, vendedor
conectado, agentes NVIDIA y chat preventivo. Odoo conectado sin registros no
valida asociaciones documentales completas. Los cambios M07/M08 de esta sesión
se publicaron posteriormente en `322eff4`; los logs de arranque confirman las
migraciones aplicadas. No se envió evidencia a PayPal.

## Pruebas pendientes del flujo real

- [ ] Comprador Sandbox abre una disputa genuina sobre el pago del vendedor conectado.
- [ ] Webhook firmado real → M02 → M07: entrega, deduplicación, captura correcta y aislamiento.
- [ ] Investigación y verificación independientes con originales suficientes del caso real.
- [ ] Aprobación explícita del ADMIN sobre la revisión vigente.
- [ ] Lectura de acción elegible y `provide-evidence` real autorizado, con respuesta registrada.
- [ ] Conciliación de resultados ambiguos sin duplicar presentaciones.
- [ ] Seguimiento hasta resolución oficial PayPal sin inferir ganador.

Estas pruebas externas quedan pendientes por decisión del usuario. Los casos
MOCK locales no las sustituyen.

## Trabajo funcional pendiente

1. Conectar el frontend con la nueva revisión/aprobación de disputa y estados
   PENDING/UNKNOWN; revisar manualmente intentos inciertos antes de habilitar otro.
2. Ampliar el envío directo a tipos documentales requeridos por PayPal y revisión
   de originales adjuntos del caso. La ruta actual se detiene ante esos requisitos.
3. Completar el workflow autónomo M07 si se requiere: ciclos persistentes limitados,
   estados de progreso y escalamiento, respetando los contratos de mediación.
4. Configurar y verificar correo de invitaciones y datos adicionales del wizard M01; entrega automática del
   enlace de conciliación según quién controle el checkout.
5. Reproducir el 500 observado en actividad remota; no confundir esa observación
   histórica con un fallo demostrado en todas las versiones actuales.
6. Validaciones externas de Odoo con datos, 17TRACK y aislamiento de vendedores.
7. Publicación autorizada del código, licencia elegida por el equipo y video de
   menos de tres minutos. No cambiar visibilidad del repositorio sin autorización.

## Validación de este incremento

- `pnpm check`: aprobado, 459 pruebas unitarias/HTTP, Prisma, lint, formato,
  tipos y build. La última ejecución completa terminó con código 0.
- Migraciones: 27 aplicadas en PostgreSQL 18.6 desechable y repetidas sin
  pendientes. Las cuatro nuevas migraciones M08 también aparecen aplicadas en
  los logs del despliegue publicado.
- `pnpm test:db`: suite completa aprobada con 214 pruebas. Después se añadió
  la prueba HTTP del ciclo M07/M05/M06 y se habilitó RLS M08; la suite específica
  `submissions.db.spec.ts` pasó con 12 pruebas sobre el estado final. Sus pruebas
  se solapan con las 214 y los conteos no deben sumarse.
- `pnpm test:mediation`: 162 pruebas aprobadas; cobertura 91,47% de líneas y
  82,20% de ramas. Este subconjunto también se solapa con las suites anteriores.
- `git diff --check`: aprobado. El cambio previo del submódulo frontend se conserva.
- Se completaron dependencias locales ausentes mediante
  `pnpm install --frozen-lockfile`, sin modificar el lockfile. El fallo inicial
  de NLP por paquetes faltantes quedó resuelto sin cambiar el clasificador.

Las pruebas usan PostgreSQL desechable real y proveedores PayPal/JWKS/LLM MOCK
identificados. Las pruebas de despacho simulan la interfaz pública M06 calificada;
los controles de esta interfaz se prueban por separado. La prueba HTTP del ciclo
M07/M05/M06 conserva persistencia real y simula los motores IA con un resultado
INCOMPLETE, sin inferencias externas ni envío. No se ejerció el flujo externo
anterior. La publicación posterior en Render aplicó las migraciones y se
verificó mediante su dashboard, logs y lecturas HTTP; no mediante SQL remoto.

## Guías de referencia

[Arquitectura](docs/architecture.md), [M01](docs/m01-merchants.md),
[M02](docs/m02-event-ingestion.md), [M03](docs/m03-transactions.md),
[M04](docs/m04-evidence.md), [M05](docs/m05-investigator.md),
[M06](docs/m06-verifier.md), [M07](docs/m07-disputes.md),
[M08](docs/m08-submissions.md), [M09](docs/m09-monitoring.md),
[despliegue](docs/deployment.md) y [evidencia previa](docs/validation.md).
