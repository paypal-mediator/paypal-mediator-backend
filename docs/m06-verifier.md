# M06 ? Verificaci?n independiente INR

Implementaci?n local integrada con M05. Sin pruebas ejecutadas ni migraci?n aplicada
para este incremento, por indicaci?n del usuario. No desplegado ni verificado con servicios externos.

## Flujo p?blico

1. ADMIN solicita `POST /api/transactions/:transactionId/investigations` (M05).
2. Comprueba `status=COMPLETED`, `stale=false` y conserva `id`.
3. ADMIN solicita `POST /api/transactions/:transactionId/investigations/:investigationId/verifications`
   con `{ "idempotencyKey": "UUID" }` y permiso `allowInvestigations=true`.
4. Consulta la misma ruta por GET (?ltimas 20) o `GET .../verifications/:id`.
   ADMIN/VIEWER pueden leer. POST devuelve 201 con recurso RUNNING/COMPLETED/FAILED:
   comprobar status/errorCode, no interpretar el HTTP como aprobaci?n.

Interfaz p?blica para futuros consumidores: `VerifierService.verify(actor,
transactionId, investigationId, { idempotencyKey })`, exportada por `VerifierModule`.
M06 consulta M05 por `InvestigatorService.detail`, y originales por el contrato
p?blico de M03/M04. Nunca escribe resultados en tablas privadas de M05.

## Independencia y bloqueos

Prompt versionado `m06-inr-v1`, conversaci?n nueva, trace, presupuesto y lecturas
propias. Comparte solamente el transporte NVIDIA/OpenAI con M05, no su conversaci?n,
razonamiento ni conjunto de documentos le?dos. El borrador se entrega como dato no
confiable; la revisi?n exige volver a inspeccionar originales y citar IDs vigentes.
El prompt audita resumen y respuesta sugerida, procedencia, identidad, fechas,
importes, relevancia, cobertura y afirmaciones sin soporte.

El modelo propone APPROVED/INCOMPLETE/REJECTED. TypeScript impide aprobaci?n con
faltantes, fuentes no inspeccionadas, cobertura sin evidencia verificada, DEMO,
identidades incompatibles, procedencia inv?lida, conflictos o borrador sin soporte.
REJECTED conserva prioridad sobre INCOMPLETE. READY de M04 no implica aprobaci?n.
El control sem?ntico de afirmaciones depende del modelo; las citas y el schema
por s? solos no prueban verdad. Los bloqueos deterministas no los reemplaza el modelo.

?mbito expl?cito `PREVENTIVE_INR`, `submissionAuthorized=false` siempre. APPROVED
es preparaci?n interna: M07/M08 deben aportar contexto de disputa real, acciones
PayPal, vigencia y autorizaci?n antes de cualquier presentaci?n. No hay herramientas
de env?o, SQL, navegaci?n ni escritura accesibles al modelo.

## Persistencia y l?mites

Migraci?n `20261107010000_verification_runs`: tabla propia con RLS sin pol?ticas
p?blicas, FK compuesta a investigaci?n/transacci?n/merchant, hashes de snapshot y
resultado, idempotencia por merchant/investigaci?n/clave y un RUNNING por transacci?n.
El snapshot conserva borrador y originales JSON, nunca bytes de im?genes ni secretos.
No mantiene transacci?n de DB durante inferencia. Timeout/fallo deja FAILED sin
veredicto; lease vencido se muestra expired y se recupera en la siguiente solicitud.

Requiere investigaci?n COMPLETED vigente. Si cambia la revisi?n durante inferencia,
registra FAILED/VERIFICATION_STALE; los resultados hist?ricos exponen stale al leer.
Un consumidor nunca debe utilizar una aprobaci?n stale ni un recurso FAILED.
Las im?genes se descargan de M04 con hash verificado, m?ximo dos por revisi?n.
PDF no analizado no cuenta como fuente inspeccionada. L?mite de snapshot 256 KiB,
contexto textual 128000 caracteres, respuesta del proveedor 512 KiB.

Configuraci?n: mismo AI_PROVIDER y credenciales del proveedor seleccionado que M05,
sin fallback silencioso. `VERIFIER_MAX_STEPS=12`, `VERIFIER_TIMEOUT_MS=90000`.
OpenAI conserva Responses con schema estricto y store=false seg?n la
[documentaci?n oficial de Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
No se realizaron llamadas de inferencia durante esta implementaci?n.

No hay reinvestigaci?n autom?tica: INCOMPLETE informa faltantes para corregir fuentes
y solicitar otra investigaci?n/verificaci?n expl?cita. M07 debe coordinar el l?mite
MAX_INVESTIGATION_ROUNDS; ese valor no equivale al n?mero de pasos de cada agente.

## Integraci?n de M05

Prompt M05 v1.2 reconoce las fuentes persistidas de orderEnrichment, sin afirmar
consulta comercial en vivo. commercialSource=AVAILABLE requiere un registro MATCHED
con integridad VALID; NOT_CONNECTED se conserva para snapshots anteriores o sin
fuentes disponibles. No indica por s? solo conexi?n ERP. M05 tambi?n falla si el
expediente cambia durante inferencia. requiresVerification=true se conserva: el
resultado de M06 se consulta como recurso independiente, no autocertificaci?n.

## Validaci?n pendiente

Ejecutar posteriormente pnpm check, migraciones y pnpm test:db sobre PostgreSQL de
pruebas; cubrir permisos, aislamiento por merchant, idempotencia/concurrencia,
leases, stale, FK/RLS, bloqueos, citas, im?genes y prompt injection. La integraci?n
real con NVIDIA/OpenAI/Storage requiere servicios y configuraci?n externos.

Comprobaciones est?ticas ejecutadas: generaci?n local del cliente Prisma (ignorado
en Git), validaci?n de schema Prisma, typecheck de contratos/API y ESLint aprobados.
No se ejecutaron pnpm check, suites de pruebas, migraciones ni llamadas de inferencia.

## Correcci?n de los cuatro hallazgos (prompt v2)

El servidor construye requiredClaimUnits desde TODO el resumen, cada hallazgo,
cada contradicci?n y suggestedResponse. Divide en frases/l?neas conservando el
texto y asigna IDs estables por campo e ?ndice. M06 debe devolver una evaluaci?n
por unidad con texto exacto, conclusi?n, explicaci?n y citas. Unidades omitidas
impiden APPROVED; IDs inventados, texto alterado o duplicados producen REJECTED.
SUPPORTED exige fuentes le?das e incluidas en verifiedEvidenceIds. UNSUPPORTED o
CONTRADICTED rechazan, NOT_VERIFIABLE deja INCOMPLETE. NON_FACTUAL requiere
justificaci?n y solo corresponde a texto sin hechos. Una frase con varios hechos
se eval?a completa: un solo hecho falso impide SUPPORTED. La clasificaci?n y la
relaci?n sem?ntica entre texto/fuente siguen dependiendo del modelo; estos controles
hacen obligatoria y auditable la evaluaci?n, sin garantizar infalibilidad del LLM.
M?ximo 256 unidades; no se trunca silenciosamente un borrador mayor.

checklist es un objeto obligatorio con PROVENANCE, INTEGRITY, IDENTITY, CONSISTENCY,
RELEVANCE, COVERAGE, EXPLAINABILITY y CURRENTNESS. Cada dimensi?n incluye status
PASS/FAIL/NOT_EVALUATED, explanation y evidenceIds. PASS sin citas impide aprobaci?n;
NOT_EVALUATED permanece expl?cito e impide aprobaci?n. FAIL de cobertura/vigencia
implica INCOMPLETE; los dem?s FAIL implican REJECTED. Los bloqueos deterministas
actualizan tambi?n la dimensi?n afectada y prevalecen sobre el modelo.

La comparaci?n de carrier usa toUpperCase(), como M04; el tracking conserva su
comparaci?n exacta. DHL y dhl ya no son una contradicci?n por capitalizaci?n.

Despu?s de cualquier REJECTED de esa transacci?n, una clave nueva o investigaci?n
nueva devuelve 409 VERIFICATION_REJECTION_REVIEW_REQUIRED salvo revisi?n expl?cita
del ADMIN. Se exige referenciar el rechazo m?s reciente del mismo merchant y
transacci?n, con justificaci?n de al menos 20 caracteres:

```json
{
  "idempotencyKey": "UUID-nuevo",
  "rejectionReview": {
    "verificationId": "UUID-del-rechazo-mas-reciente",
    "justification": "Revis? el rechazo y document? la correcci?n o el motivo para reconsiderarlo."
  }
}
```

La revisi?n permite otra evaluaci?n independiente; nunca convierte un resultado
en APPROVED. No hay desbloqueo autom?tico por un simple cambio de revision. Se
persiste rejectionReview con actorUserId y reviewedAt generados en servidor dentro
del snapshot protegido por hash, y se expone en la respuesta. El control corre
bajo el mismo lock de adquisici?n, antes de inferencia. Repetir la clave original
recupera el recurso existente sin cambiar el rechazo ni registrar otra revisi?n.
Un rechazo posterior exige revisar ese nuevo rechazo. No existe autorizaci?n de
reintento impl?cita ni autom?tica por corregir datos.

Cambio de contrato: claims y checklist son obligatorios en resultados v2;
rejectionReview es opcional en POST y nullable en respuesta. El almacenamiento
utiliza las columnas JSON existentes: no se agrega migraci?n. Los consumidores
HTTP deben adoptar estos campos; un resultado v1 no acredita los controles v2.

Estas correcciones a?n no tienen validaci?n funcional: por indicaci?n del usuario
no se ejecutaron pruebas ni llamadas externas. Se revisan tipos y ESLint.

El presupuesto de salida de M06 pasa a 8192 tokens por paso para el resultado
con checklist y afirmaciones; M05 conserva 3072. El l?mite de tiempo/pasos y la
validaci?n de truncamiento siguen activos. Resultados hist?ricos incompatibles
con el contrato actual devuelven 409 VERIFICATION_RESULT_REVIEW_REQUIRED; no se
completan autom?ticamente campos de auditor?a ni se presentan como aprobaciones v2.
