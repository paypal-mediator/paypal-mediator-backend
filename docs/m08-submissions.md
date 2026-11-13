# M08 — Presentaciones e integración con M07

Incremento local del 13 de noviembre de 2026. No publicado ni validado con
una presentación real a PayPal. Estado vigente general: [information.md](../information.md).

## Flujo y contratos

1. M07 recibe eventos verificados por M02 y vincula por captura exacta.
2. ADMIN solicita `POST /api/disputes/:id/investigate` con `idempotencyKey` UUID.
   La composición ejecuta una ronda M05 y M06 sobre un caso INR abierto y vinculado.
   Los opt-ins M01, límites, errores e idempotencia de ambos agentes se mantienen.
   Un caso cambiado o contexto de otra disputa detiene el ciclo.
3. M06 guarda el caso, mensajes y versión del evento dentro de un snapshot con
   hash. La verificación puede solicitarse también con `disputeId` en la ruta
   existente de verificaciones de investigación. `scope=DISPUTE_INR` identifica
   ese alcance; `PREVENTIVE_INR` no habilita presentaciones.
4. ADMIN solicita `POST /api/disputes/:id/submit` con UUIDs `idempotencyKey`,
   `verificationId` y `approve: true` para aprobar el intento concreto.
5. M08 consulta interfaces públicas M01/M03/M06/M07 y escribe sus propias tablas
   y auditoría transaccional M09. Solo la última revisión COMPLETED/APPROVED,
   íntegra, vigente, sin DEMO, con ocho PASS y afirmaciones respaldadas permite
   avanzar. La revisión debe coincidir con el evento actual del caso.
6. Se reserva PENDING antes de llamar PayPal. Se vuelve a leer su detalle y
   validar captura, motivo, mensajes, estado, etapa y enlace de acción permitido.
   También se repiten los controles locales de políticas y revisión vigente.
7. La entrega confirmada se guarda como SUBMITTED; no se modifica el estado
   oficial de PayPal ni se infiere el resultado de la disputa.

Cada servicio escribe sus tablas. La composición de la ruta de investigación
reside junto a VerifierModule para evitar el ciclo de dependencias
DisputesModule → InvestigatorModule → DisputesModule.

## Idempotencia, concurrencia y recuperación

La clave UUID global se vincula mediante `request_hash` a merchant, disputa,
actor, revisión y aprobación. Reutilizarla para otra solicitud produce 409;
una repetición válida devuelve el registro existente. El caso se autoriza antes
de consultar la clave, evitando exponer registros ajenos.

Locks transaccionales por clave y por caso serializan la adquisición. Un índice
único parcial impide más de un registro PENDING/UNKNOWN/SUBMITTED por caso.
Los registros BLOCKED o FAILED previos no impiden corregir un preflight con una
clave nueva; se conserva cada intento y sus eventos de auditoría.

- PENDING conserva la reserva incluso si el proceso cae. Requiere inspección
  operativa; no expira automáticamente ni vuelve a enviar.
- UNKNOWN identifica un resultado incierto desde el inicio de la operación de
  entrega. OAuth, timeout o rechazo posterior no se reintentan a ciegas.
- FAILED indica fallo anterior a esa operación. Nunca representa un envío.
- SUBMITTED requiere HTTP 200 confirmado por el cliente, que admite cuerpo vacío.
- BLOCKED representa rechazo determinista antes del preflight PayPal.

La conciliación de PENDING/UNKNOWN es manual en este incremento; no hay endpoint
que libere reservas ni presuma rechazo del proveedor. Conservar el registro y la
auditoría al investigar. El cliente no asume idempotencia PayPal para todas las
acciones, aunque envíe `PayPal-Request-Id`.

## Alcance de la evidencia

El envío directo usa multipart con campo `input` y `evidences`, tipo `OTHER`
y notas de hasta 2000 caracteres derivadas únicamente de afirmaciones SUPPORTED
por M06. Los UUID del vault permanecen como citas internas; no son evidence IDs
del proveedor. No se omiten silenciosamente afirmaciones demasiado largas.

Se detiene ante requisitos específicos distintos de OTHER, adjuntos del caso
no revisados o supporting_info. Su soporte completo exige otra ampliación;
no se afirma que unas notas sustituyan comprobantes de entrega solicitados.
El módulo de mediación conserva su flujo documental y controles propios.

Referencia consultada: [PayPal Provide evidence](https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence),
que exige una acción HATEOAS disponible para el caso. Esta revisión no ejecutó
llamadas comerciales ni presentó evidencias reales.

## Migración y validación

Aplicar `20261113040000_submission_safety` antes de publicar el código. Añade
`request_hash` nullable para compatibilidad histórica y reemplaza la unicidad
por caso por un índice normal y la unicidad parcial de envíos activos.
`20261113050000_submission_audit` permite M08 en la restricción de auditoría;
`20261113060000_submission_legacy_reconciliation` convierte FAILED históricos
sin request_hash en UNKNOWN, porque su entrega no puede descartarse.
`20261113070000_submission_rls` activa RLS sin políticas públicas en las dos
tablas M08; la conexión backend necesita el rol propietario o BYPASSRLS.
No se editan migraciones anteriores ni se eliminan intentos existentes.
Los registros históricos sin hash no se reproducen como solicitudes nuevas.

Pruebas: `submission-guard.spec.ts`, `submission-review.spec.ts`,
`dispute-workflow.spec.ts` y `submissions.db.spec.ts`. Las pruebas de DB usan
NestJS, HTTP, locks e índices PostgreSQL reales; JWKS/PayPal son MOCK. En las
pruebas de despacho se simula explícitamente la interfaz pública M06 calificada;
sus controles de integridad/vigencia/caso se prueban aparte y los agentes tienen
sus suites existentes. Los resultados finales están en `information.md`.

Pendiente de prueba externa: disputa genuina, webhook, investigación/revisión,
aprobación ADMIN, acción elegible, presentación y resolución oficial. Pendiente
de frontend: aprobación con verificationId y representación de PENDING/UNKNOWN.
