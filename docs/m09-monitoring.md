# M09 — Monitoring & Audit

M09 conserva eventos append-only en `audit_events`. ADMIN y VIEWER con JWT y
membresía activa pueden consultar el timeline y las métricas. El merchant
procede de la sesión, nunca de un parámetro del cliente. No hay escritura HTTP.

## Productores

| Módulo | Actividad registrada                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| M01    | Configuración y comprobación de conexión PayPal                                                       |
| M02    | Webhooks verificados, ignorados, duplicados, firmas rechazadas, conflictos y finalización de trabajos |
| M03    | Capturas nuevas, órdenes creadas y consultas a fuentes de pedidos                                     |
| M04    | Versiones nuevas de evidencia, refresh y descarga íntegra de archivos                                 |
| M05    | Inicio, pasos, finalización, errores y recuperación de ejecuciones vencidas                           |
| M06    | Inicio, pasos, veredicto, errores y recuperación de ejecuciones vencidas                              |

El resultado operativo SUCCEEDED en M06 significa revisión terminada: el
veredicto separado puede ser INCOMPLETE o REJECTED y no autoriza envíos.
Un interceptor registra los errores de solicitudes autenticadas sin copiar
cuerpos ni mensajes originales. Los rechazos de guards no se atribuyen a un
merchant sin actor autorizado. Las firmas rechazadas son intentos no verificados,
nunca eventos auténticos. Los errores anteriores a obtener el contexto del
merchant no generan auditoría.

## Contrato HTTP

- `GET /api/activity`: filtros `module`, `action`, `outcome`, `transactionId`,
  `resourceType`, `resourceId`, `from`, `to` y `limit` (1–100; 20 por defecto).
- `nextCursor` devuelve `before` y `beforeId`; deben enviarse juntos, conservando
  los filtros. Se ordena por fecha e ID descendentes para resolver empates.
  Las páginas no constituyen un snapshot; las entradas nuevas aparecen al
  reiniciar el listado.
- `GET /api/activity/metrics?hours=24`: ventana de 1–744 horas; grupos por
  módulo/acción/resultado, conteos, duración media y muestras, tokens observados
  y conteos de veredictos. `current` devuelve estados persistidos de ingesta,
  fuentes de pedidos e investigaciones/verificaciones mediante interfaces públicas.
  Estos contadores incluyen trabajos históricos y no dependen de la ventana.
  Son consultas independientes, no un snapshot atómico entre módulos. Un fallo
  de consulta produce error, nunca ceros ficticios.

Las métricas históricas llevan `scope=AUDITED_EVENTS_SINCE_M09`: no se inventa
actividad anterior a la instrumentación. Los tokens reportados por respuestas
válidas no son una factura; el consumo de peticiones fallidas puede no conocerse.
Las duraciones STEP y FINISHED tienen distinto alcance y se agrupan por acción;
no deben sumarse entre sí.

## Persistencia y privacidad

`AuditModule` publica `AuditService.append(input, tx)`. La transición y su evento
comparten transacción; un fallo de auditoría revierte la transición. Cada
productor conserva sus propias tablas e historial.

Los pasos IA se guardan con el resultado terminal, incluyendo fecha observada,
duración, herramienta e ID de evidencia. No hay streaming de pasos en curso.
Si el proceso muere, queda STARTED/RUNNING; una nueva solicitud recupera la
ejecución vencida y registra FAILED sin inventar pasos perdidos. Los replays no
duplican inicios, resultados ni consumo. AGENT conserva el usuario solicitante;
las lecturas internas sin usuario directo se etiquetan SYSTEM.

El contrato de metadatos es cerrado. No se guardan prompts, respuestas de IA,
documentos, nombres de archivo, datos personales, cuerpos HTTP, contraseñas,
tokens o credenciales. Los enlaces a recursos no sustituyen su autorización.

Las migraciones `20261107020000_monitoring_audit` y
`20261107030000_monitoring_operations` agregan correlación por transacción y
recurso, actores, resultados, duraciones, tokens e índices. Habilitan RLS sin
políticas públicas y un trigger que rechaza UPDATE, DELETE y TRUNCATE. Un
administrador puede alterar triggers: esto no es almacenamiento externo
inmutable frente al administrador de PostgreSQL. No hay FK hacia identidades
ni recursos para conservar historia tras su eliminación. No hay borrado HTTP
ni retención automática. No se reconstruyen eventos históricos de M01.

## Alcance y validación

M07 y M08 continúan pendientes. Sus productores se incorporarán cuando existan.
No se implementan alertas externas ni pantalla frontend en este repositorio.
El despliegue y las pruebas live se documentan por separado.

Ejecutar `pnpm check`, migraciones y `pnpm test:db`, repetir `pnpm db:deploy`
y comprobar ausencia de diferencias con Prisma migrate diff. La suite cubre
aislamiento por merchant, paginación con empates, filtros, métricas, rechazo de
metadatos privados, RLS, inmutabilidad, rollback y telemetría idempotente.
Las pruebas automatizadas usan PostgreSQL desechable real y servicios externos
MOCK explícitos.

## Validación publicada — 2026-11-07

PR #16 integrado en `main` (`65bd498`), CI aprobado y rutas M09 verificadas en
Render. `pnpm check` pasó con 191 pruebas unitarias/HTTP y `pnpm test:db` con 95.
Las 12 migraciones se aplicaron en PostgreSQL desechable, se repitieron y Prisma
no detectó diferencias. Render aplicó las dos migraciones M09 en Supabase al
arrancar; timeline y métricas autenticados devolvieron HTTP 200.

Nuevo pago PayPal Sandbox de 1 USD ficticio: orden `4P679551HB887882T`, captura
`7NG16302DE1762820`. El usuario inició sesión y el asistente aprobó el checkout
controlando Opera GX mediante CDP local 9223. M02 verificó el webhook genuino,
M03 enriqueció los dos artículos desde Orders v2 y M04 conservó originales
íntegros; refresh sin duplicar versiones. NVIDIA real ejecutó M05 COMPLETED y
M06 COMPLETED con veredicto REJECTED: faltan tracking/entrega y una afirmación del
borrador no tiene apoyo verificado. Los replays conservaron IDs, uso y un único
inicio/fin de auditoría por ejecución.

Un PNG DEMO recorrió carga, descarga con bytes/SHA-256 idénticos y deduplicación
en Storage real. Se creó una orden comercial DEMO idempotente; tracking/entrega
DEMO llevaron el checklist a READY y una contradicción a NEEDS_REVIEW. La
investigación con el PNG inicial de 1 píxel falló AI_PROVIDER_REJECTED. Se
reemplazó por un PNG RGB de 512×128; el siguiente borrador fue bloqueado por
AI_UNSUPPORTED_CITATION. Ambos fallos permanecen registrados; no se continuaron
reintentos pagados ni se relajaron las citas.

M06 bloqueó HTTP 409 la investigación obsoleta. La exigencia de revisión humana
de un rechazo está cubierta por las pruebas PostgreSQL; en el segundo caso live
no se alcanzó ese control porque M05 no produjo una investigación nueva válida.
No se afirma un APPROVED live. `/api/activity` mostró M01–M06, paginación sin
repetir IDs y acceso sin sesión 401; métricas 200, módulo M08 inválido 400.
Se restauró la política original: investigaciones y envíos deshabilitados,
aprobación humana obligatoria. No se usaron M07/M08.

Ver [evidencia sanitizada](evidence/m09-m01-m06-sandbox-20261107.json).
