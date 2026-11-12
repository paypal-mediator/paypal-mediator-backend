# Validación local de mediación — 11 de noviembre de 2026

Implementación local en backend y frontend clonado; sin despliegue ni llamadas
financieras o envíos reales. Node 24.22.3 y PostgreSQL 18.6 desechable local.
La configuración de CI conserva PostgreSQL 17; no se ejecutó GitHub Actions.

| Comprobación ejecutada                   | Resultado                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm check`                             | Aprobado: Prisma, lint, formato, tipos, 362 pruebas unitarias/HTTP y build |
| `pnpm db:deploy`                         | 19 migraciones aplicadas desde cero en PostgreSQL de pruebas               |
| Repetir `pnpm db:deploy`                 | Sin migraciones pendientes                                                 |
| `pnpm test:db`                           | 166 pruebas aprobadas en una base nueva                                    |
| `pnpm test:mediation`                    | 162 pruebas aprobadas; subconjunto de unitarias/integración con cobertura  |
| Cobertura del alcance nuevo configurado  | 91,46% líneas; 90,60% statements; 82,62% ramas; 97,67% funciones           |
| Frontend `npm test`                      | 36 pruebas aprobadas                                                       |
| Frontend lint, tipos y build             | Aprobados                                                                  |
| `docs/sql/mediation-down.sql`            | Aplicado en otra base desechable; cero tablas mediation restantes          |
| `git diff --check` en ambos repositorios | Sin errores                                                                |

Los umbrales se ejecutan en `vitest.mediation.config.ts` y CI: 90% líneas,
85% statements, 80% ramas y 90% funciones. El reporte HTML/JSON de cobertura se
genera en `coverage/mediation/`, ignorado en Git. La cifra de 162 no se suma a
las suites normales: mide nuevamente su subconjunto de mediación.

Las pruebas usan NestJS y PostgreSQL reales con PayPal, LLM y JWKS MOCK.
Comprueban acuerdos bilaterales, rechazos, demanda del comprador/vendedor,
vencimiento, datos inválidos, concurrencia e idempotencia, límites de frecuencia,
pruebas originales, PDF legible, adjuntos PayPal y supporting_info, recuperación
de una interrupción de envío, dictamen con citas y prohibición de endpoints
financieros. La firma válida/inválida y webhooks repetidos siguen cubiertos por
las suites M02 existentes. Los cambios de rastreo en paralelo se conservaron.

Una repetición de `test:db` sobre una base temporal con datos acumulados produjo
un fallo del test de rastreo que asume un único lote de candidatos. La ejecución
final sobre una base nueva, equivalente al aislamiento de CI, aprobó las 166
pruebas. No se modificó ese worker para ocultar el fallo.

La inspección Prisma no encontró deriva en las tablas nuevas de mediación.
Sí detectó diferencias preexistentes de nombres/defaults/timestamps en planes,
suscripciones y submissions; no se refactorizaron por estar fuera del alcance.

No se midió precisión/recall del modelo real ni se probó un expediente contra
una disputa Sandbox genuina. OAuth/scopes de documentos, disponibilidad del
proveedor LLM, Storage y acciones HATEOAS siguen siendo dependencias externas.
El sistema bloquea resultados no verificables; los mocks no certifican la
aceptación real de un payload por PayPal ni la calidad semántica de un modelo.

Activación, contratos y límites: [guía de mediación](mediation.md).
