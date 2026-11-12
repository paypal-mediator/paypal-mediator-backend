# Mediación de disputas existentes

## Análisis previo y alcance

El backend usa NestJS 11, TypeScript estricto/ESM, Node 24, pnpm 10.34.9,
Prisma 7/PostgreSQL, Zod y Vitest/Supertest. Se revisaron `information.md`,
arquitectura, módulos, contratos, migraciones, CI y el frontend clonado.

La interfaz `DisputeConversation.jsx` conservaba mensajes en localStorage y
un reporte inicial fijo; `LiveDisputes.jsx` mostraba eventos y borradores.
La conexión real se agrega al modo live utilizando los estilos existentes.
El comprador participa desde su disputa de PayPal; no se inventa una identidad
de comprador ni se permite al vendedor publicar con autor BUYER.

Se reutilizan M01 (JWT, membresías, configuración y OAuth), M02 (webhooks
firmados y deduplicados), M03 (órdenes y vinculación de capturas), M04 (vault,
originales, Storage y hashes), el transporte M05, M06 para revisión independiente,
M07 para disputas oficiales, M08 para el cliente de envío y M09 para auditoría.
Los cambios de shipment-tracking que se desarrollan en paralelo se conservan.

No existe una disputa: no se inicia mediación, no se crea una disputa PayPal ni
se envía un aviso. Las órdenes/capturas y expedientes preventivos preexistentes
conservan su comportamiento. La detección funciona sobre mensajes de una
disputa PayPal existente. El botón manual vive en el detalle de esa disputa.

## Activación

1. Aplicar migraciones con `pnpm db:deploy`. Este trabajo no despliega servicios
   ni aplica cambios en bases compartidas.
2. Configurar JWT/Supabase, Storage privado, proveedor LLM y credenciales Sandbox
   existentes. PayPal permanece restringido al merchant de `MERCHANT_ID`.
3. En Merchant settings → Mediation configurar política real, días y ventanas,
   soluciones permitidas y autorización de envío automático. Activar también
   `allowInvestigations` y, para presentación, `allowSubmissions` de M01.
4. Activar `MEDIATION_WORKER_ENABLED=true` (por defecto en producción salvo
   override; false en desarrollo/pruebas). El worker revisa cada 30 segundos,
   procesa disputas existentes y recupera el trabajo desde PostgreSQL.

Las políticas se guardan por negocio y cada caso conserva un snapshot. La
revocación de permisos M01 y de autorización automática se comprueba antes del
envío. El permiso explícito de mediación no modifica el contrato legacy de M08,
que continúa exigiendo su aprobación manual.

## Estados y agentes

`detectado → abierto → en_conciliacion → acuerdo → cerrado`.
Alternativa: `en_conciliacion → sin_acuerdo → demanda_admitida →
recopilando_pruebas → dictaminado → escalado_a_paypal → cerrado`.

Cada transición registra fecha, agente y motivo en una tabla append-only; M09
registra también cambios de estado y bloqueos, con hashes y códigos, sin textos
personales en los logs. Una resolución oficial PayPal puede cerrar cualquier
etapa; un dictamen local nunca se convierte en un resultado financiero oficial.

El detector devuelve intención, tipo, gravedad, resumen y confianza. Menos de
0.85 o intención ambigua deja un candidato `detectado` y solicita confirmación.
No repite inferencia indefinidamente sobre el mismo candidato. La conciliación
propone únicamente opciones comerciales autorizadas. El evaluador exige una
demanda admitida, la ventana completa de pruebas y citas verificables. M06
recibe contexto independiente y vuelve a revisar originales y afirmaciones.

Los mensajes contienen el aviso de políticas del negocio y límites financieros.
Los prompts están versionados en `mediation/prompts/mediation.prompts.ts`.
Todo mensaje/documento/política se entrega al modelo como datos no confiables;
ningún agente recibe herramientas para SQL, secretos, pagos o envíos.

## Consentimiento y plazos

El vendedor confirma una opción desde el frontend. El comprador responde en
PayPal exactamente `ACEPTO <UUID-propuesta> <número-opción>`, `RECHAZO` o
`DEMANDA`. Solo se interpretan mensajes BUYER recuperados con OAuth de la
disputa verificada; se comprueban fecha, propuesta y opción. Una confirmación
unilateral no constituye acuerdo. El acta se notifica mediante send-message y
el caso cierra únicamente después del acuse de PayPal o su conciliación posterior.

La conciliación usa el menor plazo entre los días comerciales y el tiempo
disponible de PayPal. Se reservan ventanas de demanda, pruebas y margen de
seguridad. Se respeta el vencimiento exacto (`ahora >= límite`). Nunca se
extiende una fecha oficial. La ventana de 20 días de INQUIRY es un techo de
respaldo, no sustituye `seller_response_due_date`. Una reducción de plazo se
aplica atómicamente; falta de tiempo o cambios críticos requieren revisión.

El comprador aporta pruebas en PayPal y el vendedor en el vault. La nueva ruta
de prueba de mediación rechaza cargas fuera de plazo, DEMO, archivos activos,
tipo/tamaño inválidos y exceso de solicitudes. Una prueba agregada por una ruta
general después del cierre de la ventana bloquea el dictamen automático, en
lugar de permitir eludir el plazo. Las versiones previas no se borran.

## API y contratos

Todas las rutas requieren JWT y membresía del negocio. VIEWER puede leer;
ADMIN escribe. No se aceptan merchant/autor/rol del comprador en el cuerpo.

| Método    | Ruta                                         | Uso                                                         |
| --------- | -------------------------------------------- | ----------------------------------------------------------- |
| GET / PUT | `/api/settings/mediation`                    | Política comercial                                          |
| GET       | `/api/disputes/:id/mediation`                | Caso, mensajes y cronología                                 |
| POST      | `/api/disputes/:id/mediation`                | Reporte/inicio manual                                       |
| POST      | `/api/disputes/:id/mediation/refresh`        | Sincronizar y avanzar                                       |
| POST      | `/api/disputes/:id/mediation/messages`       | Mensaje del vendedor                                        |
| POST      | `/api/disputes/:id/mediation/actions`        | Confirmar, aceptar, rechazar, demandar, evaluar o presentar |
| POST      | `/api/disputes/:id/mediation/evidence/files` | Archivo durante la ventana de pruebas                       |

Los contratos Zod viven en `packages/contracts/src/mediation.ts`.
`pnpm mediation:schemas` exporta los JSON Schemas de entradas y salidas a
`docs/mediation-schemas.json`. La transacción, orden e importe se verifican
contra las interfaces públicas, no contra afirmaciones del modelo.

## PayPal y entrega

Referencia oficial comprobada el 11 de noviembre de 2026:
[Disputes v1](https://developer.paypal.com/api/customer-disputes/v1) y
[guía de uso](https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api/).

El cliente acepta exclusivamente GET del detalle y POST a `send-message`,
`provide-evidence`, `provide-supporting-info` y `escalate`. Comprueba identidad,
plazo, etapa y HATEOAS actual; construye URLs de un origen fijo, sin seguir
redirecciones. No implementa make-offer, accept-claim, reembolsos ni transferencias.

El expediente completo se representa en un PDF determinista sin truncamiento,
incluidos resumen, cronología, todos los registros y mensajes, política,
evaluación y dictamen. Los caracteres Unicode se conservan como escapes JSON
reversibles. Se adjuntan además los originales PDF/PNG/JPEG del vault. Máximo
10 documentos contando el informe; si no cabe completo, se bloquea, no se omite.
La entrega usa multipart y evidencia OTHER, o supporting-info según la acción
permitida. Si la disputa sigue en INQUIRY, se solicita después la gestión de
PayPal con escalate. Solo un acuse HTTP 200 permite registrar entrega.

Las escrituras se reservan antes de llamar al proveedor. Un timeout es UNCERTAIN,
no éxito. Los mensajes se concilian por autor/contenido/fecha desde PayPal;
no se reenvían a ciegas. Un expediente incierto queda bloqueado para revisión,
incluida la fase exacta alcanzada. Las lecturas y la IA usan reintentos acotados;
salidas inválidas, errores reiterados, fraude y amenazas se señalan al vendedor
como revisión especializada. No se afirma que exista entrega de email o push.

## Límites externos explícitos

La descarga de documentos adjuntos del comprador desde PayPal puede requerir
permisos adicionales de su account manager, según la referencia oficial. Este
incremento no descarga URLs arbitrarias ni certifica archivos inaccesibles:
cuando PayPal no permite descargar o inspeccionar sus adjuntos, detiene el dictamen
automático y solicita revisión. Con acceso disponible descarga únicamente desde rutas de documentos del caso en los hosts Sandbox de PayPal, valida tamaño/firma/contenido activo y conserva hashes de originales. M06 inspecciona el PDF o la imagen en contexto independiente y el envío vuelve a comprobar sus bytes. También se incluyen supporting_info y sus adjuntos, sin omitirlos. Un PDF del vault sin texto extraíble o exceso
del presupuesto de imágenes también detiene la automatización.

El escaneo de archivos es básico: firmas, tamaño, codificación, EICAR y contenido
activo PDF; no se presenta como una certificación antivirus. La valoración
semántica sigue dependiendo del modelo, aun con revisión independiente. No se
ha medido precisión/recall del modelo real ni realizado un envío Sandbox real;
los mocks comprueban controles y flujos, no calidad estadística de inferencia.

## Pruebas y reversión

`pnpm check`, migraciones y `pnpm test:db` siguen siendo obligatorios.
`pnpm test:mediation` añade cobertura v8 con mínimos de 90% líneas, 80% ramas,
85% statements y 90% funciones sobre el alcance definido en su configuración.
CI ejecuta ambos grupos con PostgreSQL; LLM, firma y PayPal usan mocks explícitos.

Para desactivar sin perder datos: `MEDIATION_WORKER_ENABLED=false` y política
enabled=false. Para revertir tablas nuevas en una base desechable o tras exportar
sus datos, usar `docs/sql/mediation-down.sql`; conserva evidencia M04 y auditoría
M09. No editar el historial Prisma aplicado ni eliminar auditoría para hacer
encajar un despliegue antiguo. Un downgrade que deba mostrar eventos M07 necesita
mantener la extensión compatible de contratos M09.
