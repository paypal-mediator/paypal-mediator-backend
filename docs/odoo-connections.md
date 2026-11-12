# Odoo Online por equipo

Connections ofrece PayPal y Odoo; Odoo es el único ERP disponible para nuevas conexiones. Los adaptadores anteriores permanecen internos para compatibilidad y pruebas, sin aparecer en el catálogo público.

Un administrador conecta una instancia con `POST /api/integrations/odoo/connect-with-key` y `{ provider: "odoo", apiKey, baseUrl, database }`. Se admiten orígenes HTTPS de una instancia `*.odoo.com`, sin rutas, puertos personalizados ni credenciales en la URL. Odoo autohospedado queda fuera de esta versión. La API externa debe estar habilitada en el plan o prueba de Odoo.

Antes de persistir se verifica `res.users/context_get` mediante JSON-2. Se usa `uid`, no `id`, para la referencia externa; la base de datos se conserva dentro del secreto cifrado. No hay cambios de schema ni migración nueva. Las conexiones se consultan y gestionan con la membresía del equipo seleccionado; las escrituras requieren ADMIN.

El frontend muestra cada conexión individual, URL, estado y última sincronización. Permite agregar varias instancias, probar acceso, solicitar sincronización y desconectar. Las claves no se recuperan desde el frontend. La desconexión es local; la clave se revoca desde Odoo. El flujo de desconexión existente elimina los registros importados de esa conexión, por lo que la interfaz solicita confirmación antes de continuar.

La sincronización usa pg-boss; una cola no disponible devuelve un error y no aparenta haber sincronizado. Las consultas vacías no prueban importación de documentos ni conciliación con PayPal.

Validacion: pnpm check (399 pruebas), migraciones existentes aplicadas y repetidas en PostgreSQL desechable, pnpm test:db (175 pruebas). Frontend: 38 pruebas, lint, tipos y build. Navegador con API MOCK verifico dos conexiones y desconexion individual. Backend local con identidad MOCK, PostgreSQL desechable y API Odoo real verifico conectar/listar/desconectar, secreto cifrado, aislamiento entre equipos y rechazo a VIEWER; lecturas de pedidos, facturas y envios reales vacias. No se validaron documentos con operaciones reales.
