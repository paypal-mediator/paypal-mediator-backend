# M06 — Verificación independiente INR

Implementado y conectado a M05. Verificado localmente el 7 de noviembre de 2026
con PayPal Sandbox, Supabase y NVIDIA reales. Migración aplicada en Supabase.
M05/M06 están desplegados en Render con NVIDIA configurado. GET autenticados y POST
por idempotencia están verificados; no hubo nueva inferencia publicada. El expediente de la compra real
de prueba quedó INCOMPLETE por ausencia de tracking y entrega.
Ver [validación](validation.md) y [evidencia sanitizada](evidence/m01-m06-sandbox-20261107.json).

## Interfaz y permisos

- POST /api/transactions/:transactionId/investigations/:investigationId/verifications:
  ADMIN con allowInvestigations=true; body con idempotencyKey UUID.
- GET en la misma ruta: últimas 20 verificaciones, ADMIN/VIEWER.
- GET .../verifications/:id: detalle por merchant/transacción/investigación.
- Interfaz pública: VerifierService.verify(actor, transactionId, investigationId, input).

Requiere una investigación M05 COMPLETED y vigente. POST devuelve HTTP 201 con
RUNNING/COMPLETED/FAILED: comprobar status/errorCode, no interpretar HTTP como
aprobación. La idempotencia evita otra inferencia sobre la misma clave.

## Revisión independiente

Prompt versionado m06-inr-v2.1, conversación, presupuesto, trace y lecturas propios.
M06 consume InvestigatorService.detail y recupera originales por la interfaz
pública de M03/M04; nunca escribe resultados en tablas privadas de M05.
Comparte únicamente el transporte NVIDIA/OpenAI, no la conversación ni el
razonamiento del investigador. Todo borrador/documento es dato no confiable.

El servidor construye requiredClaimUnits a partir del resumen, hallazgos,
contradicciones y respuesta sugerida completos, divididos en frases/líneas.
Cada unidad tiene ID estable y texto exacto: se exige una evaluación por unidad,
sin omisiones, duplicados, texto alterado ni unidades inventadas. Máximo 256;
no se trunca silenciosamente un borrador mayor.

Cada evaluación conserva statement, status, explanation y evidenceIds.
SUPPORTED exige citas inspeccionadas incluidas en verifiedEvidenceIds.
UNSUPPORTED/CONTRADICTED producen REJECTED; NOT_VERIFIABLE produce INCOMPLETE.
NON_FACTUAL requiere justificar que no hay hechos. Una frase con varios hechos
debe evaluarse completa. Omitir una unidad impide APPROVED.
La clasificación y la relación semántica texto/fuente dependen del modelo:
la evaluación es obligatoria y auditable, pero el LLM no es infalible.

## Checklist y bloqueos

El resultado exige estas ocho dimensiones, con status PASS/FAIL/NOT_EVALUATED,
explanation y evidenceIds:

| Dimensión      | Qué revisa                                                     |
| -------------- | -------------------------------------------------------------- |
| PROVENANCE     | Fuente, referencia, fecha y acceso autorizado                  |
| INTEGRITY      | Contenido y hashes de originales                               |
| IDENTITY       | Captura, pedido, tracking y comprador según campos disponibles |
| CONSISTENCY    | Importes, fechas, tracking, estados y dirección                |
| RELEVANCE      | Pertinencia para preparación preventiva INR                    |
| COVERAGE       | Originales suficientes de pago, pedido, tracking y entrega     |
| EXPLAINABILITY | Todas las unidades evaluadas y hechos sustentados              |
| CURRENTNESS    | Vigencia del snapshot respecto a verificationAsOf del servidor |

PASS sin citas y cualquier NOT_EVALUATED impiden aprobación. FAIL de cobertura
o vigencia produce INCOMPLETE; los demás FAIL producen REJECTED.
TypeScript prevalece ante conflictos: actualiza también la dimensión afectada.
DEMO y fuentes no inspeccionadas bloquean APPROVED; READY documental no aprueba.
carrier se compara con toUpperCase como M04, conservando tracking exacto.
custom_id comercial y externalId de PayPal son identificadores distintos:
la comparación con la referencia del pedido solo aplica a tracking/entrega.
La ausencia de envío no convierte automáticamente en obsoletos los originales de pago.

scope=PREVENTIVE_INR y submissionAuthorized=false siempre. No existe herramienta
de SQL, navegación, escritura ni envío a PayPal. M07/M08 deben aportar contexto de
disputa concreta, acciones PayPal, vigencia y autorización antes de una presentación.
No se ha demostrado APPROVED con entrega real ni provide-evidence.

## Rechazos y revisión humana

Después de REJECTED, una clave o investigación nueva sobre la misma transacción
requiere revisar el rechazo más reciente. Un ADMIN debe enviar:

```json
{
  "idempotencyKey": "UUID-nuevo",
  "rejectionReview": {
    "verificationId": "UUID-del-ultimo-rechazo",
    "justification": "Revisé el rechazo y documenté por qué corresponde otra evaluación."
  }
}
```

Sin revisión válida devuelve 409 VERIFICATION_REJECTION_REVIEW_REQUIRED.
Justificación mínima de 20 caracteres. No hay desbloqueo automático por cambiar
la revisión del expediente. El control corre bajo el mismo lock de adquisición.
La revisión permite evaluar otra vez; nunca convierte el resultado en APPROVED.
Se guarda en el snapshot protegido por hash con actorUserId/reviewedAt del servidor
y se expone en respuesta. Repetir una clave existente conserva el recurso original.
Un rechazo posterior exige una nueva revisión; no se borra el historial.

No hay reinvestigación automática. M07 debe coordinar MAX_INVESTIGATION_ROUNDS;
ese valor no equivale a los pasos internos de cada agente.

## Persistencia, límites y proveedor

VerificationRun es propiedad de M06. RLS sin políticas públicas, FK compuesta
a investigación/transacción/merchant, snapshot y resultado con hashes, idempotencia
y un RUNNING por transacción. No se mantiene transacción DB durante inferencia.
Timeout o fallo persisten FAILED sin resultado. Lease vencido se muestra expired;
la siguiente solicitud lo recupera. Un cambio de revisión durante inferencia falla
con VERIFICATION_STALE; los históricos exponen stale. Nunca reutilizar una
aprobación stale. Resultados v1 incompatibles devuelven
VERIFICATION_RESULT_REVIEW_REQUIRED, sin inventar los campos de auditoría v2.

Mismo AI_PROVIDER/configuración de M05; sin fallback silencioso.
VERIFIER_MAX_STEPS=12, VERIFIER_TIMEOUT_MS=90000 por defecto; la prueba externa
usó timeout explícito de 120000 ms. Máximo 8192 tokens de salida por paso M06;
M05 conserva 3072. Snapshot máximo 256 KiB, contexto textual 128000 caracteres,
respuesta del proveedor 512 KiB, hasta dos imágenes originales con hash comprobado.
Los PDF no analizados no cuentan como fuentes inspeccionadas.
No se persisten bytes de imágenes, secretos ni razonamiento interno del modelo.

NVIDIA usa response_format json_schema estricto, según la
[referencia oficial del modelo](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer).
OpenAI conserva Responses, schema estricto y store=false, según
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
OpenAI solo tiene validación MOCK; no se probó externamente por falta de clave.

## Evidencia y comprobaciones

Compra de 1 USD ficticio aprobada por el usuario: captura 9MX67512MD686194C.
M05 COMPLETED; M06 COMPLETED/INCOMPLETE, con nueve unidades evaluadas y
ocho dimensiones presentes. Siete PASS y COVERAGE FAIL. Ambos recuperados
por idempotencia sin más inferencia. El rechazo inicial por un error de comparación
se conservó y el usuario autorizó expresamente la revisión antes del reintento.
Los permisos originales se restauraron; envíos permanecieron deshabilitados.

189 pruebas unitarias/HTTP y 88 PostgreSQL aprobadas. Las pruebas M06 incluyen
inventario completo del borrador, citas, checklist, transportistas, namespaces de
identificadores, bloqueo entre claves/investigaciones y auditoría de revisión ADMIN.
Los proveedores/JWKS/comercio de las suites son MOCK; PostgreSQL es desechable real.
Diez migraciones aplicadas y repetidas, diff sin cambios. La prueba externa utilizó
servicios reales separados y no sustituyó el flujo por fixtures.
Tipos, ESLint, build y formato versionado aprobados. pnpm check se detuvo en
format:check por Implementation.md preexistente sin seguimiento; se ejecutaron
las suites por separado sin modificar ese archivo.
