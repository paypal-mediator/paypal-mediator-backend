# M05 — Investigator con NVIDIA y OpenAI intercambiables

Primer incremento backend: investigación preventiva INR solicitada por ADMIN,
con prompts versionados, lecturas autorizadas de M03/M04, imágenes originales,
resultado trazable y persistencia propia. No requiere una disputa ni M07.
NVIDIA se probó con una investigación real; OpenAI tiene adaptador y pruebas
MOCK de protocolo, sin validación externa por falta de credenciales. Este
incremento se ejecutó localmente contra Supabase real; no está desplegado en Render.

## Proveedores y contexto

El modelo solicitado es `nvidia/nemotron-3.5-super-vl-120b-a12b`, publicado en el
[catálogo oficial NVIDIA](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b).
El adaptador usa `https://integrate.api.nvidia.com/v1/chat/completions`, sin
streaming, con `enable_thinking=false` y máximo 3072 tokens de salida por paso.
La clave se usa solo en la cabecera del servidor; nunca entra en el prompt.

```dotenv
AI_PROVIDER=nvidia
NVIDIA_API_KEY=configure-outside-git
NVIDIA_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
INVESTIGATOR_MAX_STEPS=8
INVESTIGATOR_TIMEOUT_MS=60000
```

Para cambiar de proveedor:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=configure-outside-git
OPENAI_MODEL=your-compatible-model
```

Reiniciar la API tras cambiar configuración. OpenAI utiliza
`https://api.openai.com/v1/responses`, `store=false` y salida estructurada con
schema estricto. El modelo OpenAI debe admitir imágenes y Structured Outputs;
no se elige uno automáticamente. Ver la [documentación oficial de salidas estructuradas](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
No hay fallback entre proveedores, reintentos facturables ni cambio silencioso
de modelo. Solo necesita la clave del proveedor seleccionado. Sin clave/modelo
seleccionados responde 503, sin inventar un resultado.

Los prompts viven en
`apps/api/src/modules/investigator/prompts/investigator.prompts.ts`;
versión actual `m05-inr-v1.1`. El contexto se construye desde un snapshot público
de M03 que obtiene transacción y expediente en una misma lectura RepeatableRead.
M05 conserva solo los items vigentes, sin copiar bytes binarios ni historiales
completos. Límite de snapshot 256 KiB; contexto textual por llamada 128000
caracteres y hasta dos imágenes de M04 por investigación.

## Agente y herramientas de lectura

Un bucle del backend interpreta un protocolo JSON compartido por ambos
proveedores: `READ_EVIDENCE` o `FINISH`. No se utiliza tool calling nativo del
proveedor. NVIDIA usa response_format json_schema estricto y OpenAI el schema
estricto de Responses; ambos se validan con Zod antes de ejecutar una acción.
Respuestas truncadas, inválidas o con comandos fuera de la allowlist fallan.

- `READ_EVIDENCE` solo admite un ID vigente del expediente autorizado. JSON se
  entrega con origen/hash; imágenes PNG/JPEG se recuperan por la interfaz pública
  de M03/M04, verificando sus bytes originales antes de enviarlas al modelo.
- Los PDF se conservan en M04, pero su extracción/análisis no está implementado
  aquí: la herramienta devuelve `UNSUPPORTED_PDF`. Ese ID no puede citarse como
  evidencia inspeccionada. No se finge haber leído un documento por su nombre.
- `FINISH` entrega resumen, hallazgos y contradicciones con IDs leídos, faltantes,
  IDs irrelevantes y un borrador. Citas no inspeccionadas se rechazan de forma
  determinista. Ninguna herramienta puede escribir evidencia, consultar SQL,
  navegar URLs elegidas por el modelo, enviar a PayPal o acceder a secretos.

Prompts e imágenes son datos no confiables; las instrucciones incluidas en
documentos no amplían las herramientas o el alcance por merchant. M05 no cambia
el readiness de M03/M04. La respuesta conserva `requiresVerification=true`,
`containsDemo`, `commercialSource=NOT_CONNECTED`, faltantes y conflictos
deterministas del snapshot. COMPLETED significa que terminó un borrador válido
según schema/citas, no que sus afirmaciones sean verdaderas o estén aprobadas.

**No existe fuente comercial conectada.** M05 puede leer lo persistido en
M03/M04, pero no encuentra nuevos pedidos, facturas o envíos fuera del backend.
Los adaptadores comerciales son un paso posterior; no se simula una conexión real.

## HTTP, permisos y persistencia

Rutas por transacción, con JWT y membresía de M01:

- `POST /api/transactions/:transactionId/investigations`, ADMIN:
  `{ "idempotencyKey": "UUID" }`. Requiere `allowInvestigations=true`.
  Se comprueba también antes de cada llamada al modelo y antes de completar.
- `GET /api/transactions/:transactionId/investigations`: ADMIN/VIEWER,
  últimas 20 investigaciones de esa transacción.
- `GET /api/transactions/:transactionId/investigations/:id`: ADMIN/VIEWER,
  detalle del merchant autorizado.

POST crea un recurso y devuelve HTTP 201 con `RUNNING`, `COMPLETED` o `FAILED`.
El consumidor debe comprobar `status` y `errorCode`; FAILED tiene `result=null`.
RUNNING puede devolverse cuando se repite una clave mientras la primera petición
sigue ejecutándose. La inferencia inicial es síncrona y acotada. Un cliente que
agota su timeout debe consultar el estado o repetir la misma clave, no crear
otra por defecto.

M05 es propietario de `investigation_runs`; no escribe tablas privadas de M03/M04.
La octava migración agrega RLS sin políticas públicas, FK compuesta por merchant,
idempotencia y un índice parcial que permite un solo RUNNING por transacción.
La transacción DB se cierra antes de llamar al proveedor. Snapshot y resultado
tienen hashes canónicos; se guardan IDs de tools, versión del prompt, proveedor,
modelo, tiempos y tokens, sin imágenes base64, mensajes completos ni razonamiento
interno del modelo.

Timeout, pasos agotados, falta de permiso, errores del proveedor y citas inválidas
persisten FAILED. Una caída del proceso puede dejar RUNNING hasta vencer su lease:
GET muestra `expired=true`; el siguiente POST en esa transacción lo marca FAILED
antes de adquirir otra ejecución. No hay worker distribuido ni recuperación
automática en segundo plano en este incremento.

`stale=true` indica que el expediente cambió desde el snapshot. Los resultados
anteriores no se sustituyen ni se presentan como vigentes. Los ciclos de
reinvestigación de M06/M07 son posteriores; `MAX_INVESTIGATION_ROUNDS` no controla
el número de pasos del agente.

## Validación y límites medidos

Actualización del 7 de noviembre: [M01–M06](evidence/m01-m06-sandbox-20261107.json)
verifica otro pago Sandbox y la investigación con NVIDIA real tras activar schema
estricto. M05 COMPLETED y M06 INCOMPLETE por falta de tracking/entrega.
Las cifras y el diagnóstico semántico de abajo conservan el historial previo.

Pruebas automatizadas: NVIDIA/OpenAI MOCK identificados, errores/JSON truncado,
permisos y opt-in, revocación, idempotencia/concurrencia, acceso por expediente,
citaciones no inspeccionadas, imágenes originales, PDF no soportado, lease
expirado, hashes, stale y FK/RLS con PostgreSQL real desechable.
`pnpm check` aprobó 157 pruebas unitarias/HTTP y el build; `pnpm test:db` aprobó
79 pruebas PostgreSQL. Ocho migraciones aplicadas/repetidas y diff sin cambios.
Los tokens registrados corresponden a respuestas interpretadas correctamente;
un fallo de transporte o respuesta inválida puede haber consumido cuota no
recuperable en estos contadores. No constituyen un registro de facturación.

La prueba externa ejecutó NVIDIA real con Supabase Auth/PostgreSQL/Storage reales
y el expediente del pago Sandbox `0R443662EP786444T`. El agente leyó cinco
originales, incluida la foto de apuntes del usuario, y terminó en seis pasos.
Identificó la foto como irrelevante y las fuentes de envío como DEMO, con citas.
Se restauró el permiso original del merchant después; envíos permanecieron
deshabilitados. Ver [resultado original del modelo](evidence/m05-nvidia-live-20261106.json).

**La evaluación semántica sigue pendiente de M06.** En la prueba real, a pesar
del contexto, el resumen agrupó indebidamente el pago Sandbox como DEMO/MOCK y
calificó READY con datos DEMO como una contradicción. Los hallazgos individuales
sí conservaron la distinción de pago Sandbox y fuentes DEMO. El borrador original
se conserva sin corregirlo para aparentar una respuesta perfecta. Schema y citas
válidas no equivalen a verdad: no debe usarse para aprobar o enviar evidencia.

## Incremento local de integraci?n M06 (sin pruebas todav?a)

Ver [M06](m06-verifier.md) para POST/GET de verificaciones vinculadas al ID de M05.
M05 no se autocertifica: conserva requiresVerification=true. El prompt v1.2 reconoce
orderEnrichment y la respuesta permite commercialSource=AVAILABLE para originales
MATCHED v?lidos, sin afirmar una consulta en vivo ni conexi?n ERP. Se rechaza la
finalizaci?n cuando cambia la revisi?n del expediente durante inferencia.
Las cifras de validaci?n anteriores corresponden al incremento previo; esta
integraci?n a?n requiere pruebas y aplicar la migraci?n de M06.
