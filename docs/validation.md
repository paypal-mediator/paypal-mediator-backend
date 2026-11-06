# Validaciones del backend

## Base común — fea0718

Ejecutada el 5 de noviembre de 2026 en Windows, Node 24.19.0 y pnpm 10.34.9.

| Comprobación                               | Resultado                                    |
| ------------------------------------------ | -------------------------------------------- |
| Generación del cliente Prisma              | Correcta                                     |
| Validación del schema                      | Correcta                                     |
| ESLint, Prettier y TypeScript estricto     | Correctos                                    |
| Pruebas unitarias y HTTP                   | 24 aprobadas                                 |
| Pruebas contra PostgreSQL real             | 2 aprobadas                                  |
| Migración inicial en DB vacía              | Aplicada                                     |
| Segunda aplicación de migraciones          | Sin cambios pendientes                       |
| Build de contratos y API                   | Correcto                                     |
| Arranque del build y HTTP health/readiness | 200, DB conectada                            |
| Arranque en desarrollo con watch           | Correcto, readiness 200                      |
| Auditoría de dependencias                  | Sin vulnerabilidades conocidas al ejecutarla |

Para la integración local se inició PostgreSQL 18.6 temporal en loopback,
fuera del repositorio; no se usó Supabase ni una base de producción.
La prueba escribe en una transacción que se revierte. Esa herramienta temporal
no es dependencia del proyecto. El CI está configurado con PostgreSQL 17.

Los casos HTTP cubren liveness, fallo de readiness, 404 uniforme, CORS permitido
y denegado, JSON inválido sin filtración de datos y documentación desactivada
por defecto en producción. Los casos de entorno comprueban puertos, URLs,
orígenes, flags, límites de iteraciones y configuración inválida sin secretos.

En esa entrega no se implementaron ni probaron PayPal/OpenAI, autenticación,
Storage o despliegue remoto.

## M01 — Merchant e integraciones

Validado localmente el 5 de noviembre de 2026, con Node 24.19.0 y PostgreSQL
18.6 temporal. Se ejecutaron las dos migraciones en una base vacía y se volvió
a ejecutar `db:deploy` sin cambios pendientes.

- `pnpm check`: schema, cliente Prisma, lint, formato, tipos, 58 pruebas y build correctos.
- `pnpm test:db`: 19 pruebas aprobadas contra PostgreSQL real.
- `pnpm audit`: ninguna vulnerabilidad conocida al ejecutarse.
- Alta CLI ejecutada dos veces: sin duplicación de membresías ni reinicio de políticas.
- JWTs con firmas ES256 y servidor JWKS local MOCK: se verifica firma, issuer,
  audience y expiración; se rechazan tokens inválidos y usuarios anónimos.
- Membresías, roles, desactivación, configuración, historial, RLS y aprobación
  obligatoria comprobados contra la base real.
- PayPal se prueba con respuestas MOCK identificadas: OAuth, lectura, acceso
  denegado, timeout, respuestas inválidas y rotación de credenciales.

No hay credenciales de Supabase Auth ni PayPal Sandbox configuradas. Por ello,
no se ha afirmado que existan sesiones reales del proyecto o una conexión real
de PayPal verificada. Ver [configuración de M01](m01-merchants.md).
