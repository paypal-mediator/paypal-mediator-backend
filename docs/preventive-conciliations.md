# Conciliación preventiva por pedido o pago

## Flujo

Este módulo es independiente de `mediation`, que opera sobre disputas existentes de PayPal. El comprador inicia la conversación al enviar su primer mensaje desde `/contact#<token>`, sin una cuenta del dashboard. El comerciante recibe esas conversaciones y responde; Conciliations no ofrece un botón para iniciar conversaciones ni crear enlaces. La lista excluye los enlaces provisionados que todavía no tienen mensajes del comprador. M03 verifica la referencia del pedido/pago mediante sus interfaces públicas. No abre ni escala disputas PayPal.

El backend conserva un endpoint ADMIN para provisionar enlaces de acceso por pedido/pago; provisionar un enlace no inicia ni publica una conversación. El enlace contiene 256 bits aleatorios, caduca entre 1 y 30 días y se puede revocar. Solo se guarda su SHA-256; el token se devuelve una vez. Su entrega automática dentro de recibos sigue pendiente de integrar con el sistema que crea la venta; no se envían correos ni WhatsApp automáticamente. Poseer el enlace autoriza esta conversación; no equivale a identidad PayPal verificada.

El frontend retira el fragmento de la URL y conserva el token en sessionStorage de esa pestaña. Las solicitudes públicas usan `X-Chat-Token`, no parámetros de URL, y `no-store`/`no-referrer`. La respuesta pública contiene únicamente referencia comercial y mensajes publicados; nunca borradores, planes, configuraciones ni identidad interna del administrador.

## Agente clasificador y costes

El agente usa [NLP.js](https://github.com/axa-group/nlp.js), MIT, ejecutado localmente en Node con un corpus inicial propio y versionado en `contact-corpus.ts`. No utiliza LLM, servicios de inferencia remotos ni descarga pesos en producción. Las dependencias de idioma español/inglés están fijadas. Se descartó el candidato ONNX multilingüe por consumo de memoria y resultados insuficientes en esta tarea.

Primero se aplica un filtro exacto y conservador a confirmaciones claras, como «llegó bien» o «thanks, everything arrived fine». Este camino no carga el modelo NLP ni llama al generador. El resto se clasifica como queja, pregunta, intención de disputa, felicitación, agradecimiento, otro o incierto. Se usa el idioma seleccionado por el comprador; el clasificador también admite detección de idioma cuando se invoca sin él.

Solo quejas/preguntas con puntuación y margen suficientes pueden llamar al generador. Los casos ambiguos, no disponibles o con referencias a disputas quedan para revisión, sin llamar al generador. Las felicitaciones y agradecimientos no abren un caso activo. Leer, refrescar y reintentar el mismo mensaje con su clave de idempotencia no repite la generación.

El generador utiliza el proveedor ya configurado (`AI_PROVIDER` y sus credenciales); puede consumir cuota de ese proveedor. El ahorro consiste en no llamarlo para clasificar ni para mensajes sin solicitud. El modelo NLP inicial no tiene una precisión certificada: sus puntuaciones no son probabilidades calibradas. Debe ampliarse y evaluarse con mensajes reales anonimizados, incluidos negaciones, sarcasmo y mezclas de idiomas, antes de ampliar la automatización.

## Revisión y automatización

Por defecto se preparan borradores y el comerciante revisa, modifica y aprueba el texto antes de publicarlo. Puede desactivar la generación desde Settings → Conciliations. El generador no tiene herramientas para enviar mensajes, efectuar pagos o ejecutar soluciones comerciales. El chat inicial admite solo texto.

Cada regla especifica categoría, tipo de caso y soluciones/condiciones permitidas. Para envío automático requiere consentimiento explícito y textos aprobados **en ambos idiomas**. La publicación automática usa exclusivamente ese texto fijo, no una promesa generada libremente. No ejecuta reembolsos, reposiciones ni movimientos monetarios. Una modificación de política o un nuevo mensaje mientras se procesa bloquea la publicación automática de la respuesta anterior.

Se guardan clasificación, versión del clasificador, borrador, plan, versión/snapshot de política y usuario que aprobó. La respuesta enviada conserva el texto final editado. El servidor usa locks por conversación, orden secuencial de mensajes, claves de idempotencia y una respuesta única por mensaje. Una aprobación obsoleta devuelve 409. La toma de control manual impide que una generación tardía sobrescriba o publique otra respuesta.

La conversación puede resolverse o revocarse sin borrar el historial. Si se abre una disputa y M03 la vincula al mismo pedido/pago, el detalle de disputa muestra acceso a las conversaciones preventivas anteriores; no se adjuntan automáticamente a PayPal.

## API y persistencia

La interfaz del comerciante usa una tabla con búsqueda y filtros, seguida de una ruta de chat independiente `/conciliations/:id`, con el mismo estilo de Disputes. La asistencia y las reglas se configuran exclusivamente en los ajustes del equipo.

El detalle privado devuelve `chat.orderSource`: identifica la procedencia registrada de la información (PayPal, sistema conectado, carga manual, DEMO o desconocida) mediante las interfaces públicas de M03. Los snapshots importados de PayPal/ERP no se tratan como pedidos manuales. Esta procedencia no demuestra qué checkout creó el pago; `checkoutOrigin=UNVERIFIED` conserva esa distinción. No se expone este contexto en el chat público.

**Enlaces en recibos PayPal: pendientes de integración con el checkout.** Las conexiones del equipo se consultan y muestran, pero no existe un envío ni una inserción automática de enlaces en recibos. Los webhooks llegan tras el pago y [PayPal no admite modificar órdenes completadas](https://developer.paypal.com/api/orders/v2/orders-patch/). Hay que integrar el sistema que crea cada venta antes de completarla y verificar qué contenido muestra realmente PayPal; conectar la cuenta del comercio o detectar un ERP no acredita esa capacidad. El contrato devuelve `receiptLinkStatus=CHECKOUT_INTEGRATION_REQUIRED`. Los enlaces actuales se crean y comparten manualmente.

Entradas Zod: `packages/contracts/src/conciliations.ts`. Código: `modules/conciliations`. Tablas propias: `conciliation_policies`, `conciliation_chats`, `conciliation_messages`; RLS habilitado sin políticas Data API para navegadores. La autorización de equipo se aplica en el backend. VIEWER solo lee; todas las operaciones administrativas requieren ADMIN. No se escriben tablas privadas de M03/M07.

- `GET/PUT /api/conciliations/policy`
- `GET /api/conciliations` (hasta 100 recientes con mensajes del comprador; filtros opcionales `orderId`/`transactionId`)
- `POST /api/conciliations/links` con pedido **o** pago, nunca ambos
- `GET /api/conciliations/:id`
- `POST /api/conciliations/:id/approve`, `/manual-review`, `/close`, `/revoke`
- `GET /api/public/conciliations/chat`
- `POST /api/public/conciliations/messages`

Se limitan 30 enlaces por equipo/hora, 20 mensajes del comprador por conversación/hora y 180 mensajes antes de admitir otro del comprador. Cada proceso de API admite una clasificación NLP y una generación de borrador a la vez; saturación/error deriva a revisión manual y conserva el mensaje. El límite de generación se libera también si falla el proveedor; no es un límite global entre réplicas. No existe una cola ilimitada de inferencia. El historial visible cubre todos los mensajes admitidos (máximo 200 consultados).

Aplicar `pnpm db:deploy`, migración `20261112020000_preventive_conciliations`. No hacen falta credenciales nuevas ni cuentas de terceros. La política se aplica solo a mensajes nuevos; cambiarla no envía respuestas retroactivas.

## Verificación

Continuación local del 12 de noviembre: `pnpm check` aprobado (409 pruebas); 21 migraciones aplicadas y repetidas sin pendientes en PostgreSQL desechable; `pnpm test:db` aprobado (183 pruebas). La regresión de saturación verifica conservación del mensaje, aprobación manual y recuperación de capacidad del generador. El frontend separado pasó 39 pruebas, lint, tipos y build. Esta continuación no hizo llamadas a proveedores de IA reales ni aplicó migraciones o despliegues remotos.

Pruebas de NLP real local y reglas deterministas; pruebas HTTP/PostgreSQL con identidad, NLP y generador MOCK para aislamiento, idempotencia, revisión, automatización y enlaces. Prueba de navegador con PostgreSQL y NLP reales, identidad y generador MOCK: acuse positivo sin llamada, borrador privado, texto editado aprobado, respuesta automática inglesa sin generación adicional y recarga del enlace. Prueba separada con el generador real configurado en español e inglés, manteniendo privados los borradores; equipos y pedidos de estas pruebas son explícitamente DEMO/MOCK y la base de datos es desechable.
