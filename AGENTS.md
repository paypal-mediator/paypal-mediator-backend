# Instrucciones del repositorio

- Leer `information.md` y `docs/architecture.md` antes de implementar.
- Este repositorio contiene únicamente backend; el frontend vive aparte.
- Mantener un backend NestJS modular, sin éxitos ficticios.
- Ordenar archivos según `docs/architecture.md`: código en `apps/api/src`,
  pruebas por categoría en `apps/api/test`, Prisma en `apps/api/prisma`,
  contratos en `packages/contracts` y guías en `docs`.
- No subir `.env`, secretos, builds ni cliente Prisma generado.
- Usar contratos públicos y no modificar tablas privadas de otros módulos.
- Ejecutar `pnpm check` tras cambios. Si cambia persistencia, ejecutar también
  migraciones y `pnpm test:db` contra PostgreSQL de pruebas.
- Informar qué se ejecutó realmente y qué depende de servicios externos.
