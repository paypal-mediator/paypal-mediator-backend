# Validación de la base común

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

No se han probado integraciones PayPal/OpenAI, autenticación, Storage ni un
despliegue remoto: todavía no están implementados.
