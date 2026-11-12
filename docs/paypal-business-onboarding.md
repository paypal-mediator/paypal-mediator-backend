# Conectar PayPal por negocio (M01)

El registro de usuario sigue en Supabase Auth. Cada negocio se crea con su
membresía ADMIN antes de abrir PayPal. M01 conserva una conexión independiente
en `paypal_accounts`; no recibe ni devuelve contraseñas o secretos del vendedor.

## Configuración

Esta integración usa **Sandbox**, como el resto del repositorio. Requiere una
aplicación de tipo Plataforma habilitada por PayPal para Partner Referrals,
lectura y actualización de disputas de vendedores. Las credenciales de una app
REST individual no habilitan automáticamente estas funciones.

- `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`: aplicación del partner.
- `PAYPAL_PARTNER_MERCHANT_ID`: ID de cuenta del partner (13 caracteres).
- `PAYPAL_PARTNER_ATTRIBUTION_ID`: BN code proporcionado por PayPal, opcional en
  Sandbox. Si falta se omite la cabecera de atribución; no se inventa un código.
- `PAYPAL_ONBOARDING_RETURN_URL`: URL del frontend; su origen debe estar en
  `CORS_ORIGIN`. En producción debe usar HTTPS.
- `PAYPAL_WEBHOOK_ID`: webhook de esa misma aplicación, dirigido a
  `/api/webhooks/paypal`. Suscribir los eventos de captura/disputa existentes y
  `MERCHANT.PARTNER-CONSENT.REVOKED`.

Aplicar `pnpm db:deploy` antes de publicar el backend y compilar/publicar el
frontend por separado. Configurar la aplicación partner puede cambiar la cuenta
de las credenciales globales: con modo partner habilitado, el merchant legacy
también debe vincularse explícitamente. No se utiliza como fallback de vendedores
desconocidos.

## Flujo y contratos

Todas las rutas siguientes exigen JWT, `X-Merchant-Id`, membresía activa y ADMIN.

1. `POST /api/settings/integrations/paypal/connect` crea una referencia aleatoria
   que caduca en una hora, solicita `READ_SELLER_DISPUTE` y
   `UPDATE_SELLER_DISPUTE`, y devuelve `{ actionUrl, merchantId }`.
   El frontend informa del consentimiento al pulsar el botón y abre esa URL en
   otra pestaña. Solo se aceptan URLs HTTPS del sitio Sandbox de PayPal.
2. El usuario elige su cuenta Business y autoriza en PayPal. Cancelar o cerrar
   esa pestaña no marca la integración como conectada.
3. Al regresar, o desde «Check authorization», el frontend llama
   `POST /api/settings/integrations/paypal/complete`. El backend busca el vendedor
   por la referencia guardada y consulta sus permisos con PayPal. Ignora los IDs
   y flags de consentimiento del navegador. Exige email confirmado, coincidencia
   de tracking, aplicación y permisos de lectura/actualización de disputas.
4. Solo entonces persiste `CONNECTED`, el seller ID y un evento M01. Un seller
   ID no puede vincularse a dos negocios. Se descarta el diagnóstico anterior
   de conexión para evitar reutilizar resultados de otra cuenta.
5. `GET /api/settings/integrations` devuelve el estado confirmado;
   `/paypal/check` sigue siendo un diagnóstico real de OAuth y lectura de
   disputas. No autoriza por sí mismo una conexión nueva.
6. `POST /api/settings/integrations/paypal/disconnect` desactiva la conexión
   local e invalida la autorización pendiente. Para retirar también el permiso
   concedido en PayPal, el vendedor debe revocarlo desde su cuenta PayPal.

Sin configuración se devuelve `PAYPAL_ONBOARDING_NOT_CONFIGURED` (409); no hay
autorización simulada. Si PayPal no confirma permisos, se devuelve
`PAYPAL_CONSENT_PENDING` (409). Un error de proveedor devuelve 502 sin exponer
tokens ni cuerpos externos.

## Consumo por los demás módulos

M01 proporciona `PayPalAuthService.merchantHeaders()` a los clientes de pedidos,
seguimiento, documentos, mediación y presentaciones. La cabecera
`PayPal-Auth-Assertion` identifica al vendedor autorizado; el token de aplicación
permanece en el servidor. No hay fallback a la cuenta legacy para otro negocio.
Los permisos para consultar pedidos históricos y tracking dependen además de
lo que PayPal habilite a la aplicación; un 403 no produce evidencia ficticia.

En modo partner, M02 asigna webhooks por el seller ID firmado (`payee.merchant_id`,
`merchant_id` o `disputed_transactions[].seller.merchant_id`). Exige un único
vendedor conectado y verifica la firma antes de persistir o revocar acceso.
Un evento que no identifica al vendedor o identifica varios se rechaza: nunca
se asigna al negocio legacy por defecto. Los workers de transacciones, disputas
y mediación recorren las conexiones registradas mediante la interfaz de M01.

## Validación y límites

Las pruebas HTTP/PostgreSQL cubren roles, aislamiento entre negocios, tracking,
caducidad, permisos insuficientes, email sin confirmar, seller duplicado,
desconexión y cabeceras por vendedor. PayPal y el emisor de identidad son MOCK
explícitos; PostgreSQL es real y desechable. Esto no acredita aprobación de
partner, acceso real a PayPal ni despliegue en Render.

Validación local: `pnpm check` (380 pruebas), 20 migraciones aplicadas y
repetidas en PostgreSQL desechable, `pnpm test:db` (172 pruebas), y frontend
con lint, tipos, build y 37 pruebas. Navegador Chrome con proveedor MOCK:
apertura de PayPal, cancelación, consentimiento pendiente y confirmación.

### Configuración real de Sandbox — 12 de noviembre de 2026

Se creó una aplicación de tipo Plataforma con display name
`ResolveAI Platform Sandbox`, región Sandbox US. OAuth devolvió 200 y Partner
Referrals devolvió 201 con URL oficial de autorización. Tiene scopes de lectura
y actualización de disputas y Partner Referrals. PayPal no mostró un BN code;
la prueba real sin esa cabecera fue válida y el código ahora la omite si falta.

Se registró en esa aplicación un webhook dirigido al backend publicado, con
`PAYMENT.CAPTURE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`,
`CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED` y
`MERCHANT.PARTNER-CONSENT.REVOKED`.

Credenciales, partner ID y webhook ID quedaron en `.env` local y en las variables
del servicio Render `paypal-mediator-backend`. En Render se usó **Save only** y
se releyeron los siete valores para comprobar coincidencia sin exponerlos. No se
disparó un despliegue. El archivo privado `.env.paypal-platform.render` contiene
el overlay para Render; tanto ese archivo como `.env` están ignorados por Git.
El frontend no necesita secretos PayPal.

Prueba adicional: HTTP NestJS autenticado con identidad MOCK y PostgreSQL local
desechable, pero transporte PayPal real, obtuvo 201 en `/paypal/connect` y
persistió el estado `PENDING` con seller nulo. No se autorizó un vendedor ni se
acredita la finalización de onboarding. Para habilitarlo en la app publicada
faltan publicar el código backend/frontend y aplicar la migración de conexiones;
las credenciales guardadas en Render se aplicarán en ese despliegue.

Referencias oficiales:

- [Onboarding antes del pago](https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/)
- [Partner Referrals y features](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_partner_referrals_v2.json)
- [Permisos Disputes](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_disputes_v1.json)
