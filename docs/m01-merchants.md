# M01 — Merchant, usuarios e integración PayPal

M01 implementa un merchant Sandbox configurado en servidor, usuarios reales
de Supabase Auth, membresías con roles, configuración persistida y comprobación
de conectividad de PayPal. No implementa login ni pantallas: el frontend vive
en otro repositorio y utiliza Supabase Auth para crear sesiones.

## Configuración

1. Crear o seleccionar un proyecto Supabase y habilitar su proveedor de login.
   Usar claves de firma asimétricas ES256 o RS256; los JWT antiguos HS256 no
   se aceptan. Mantener deshabilitadas las cuentas anónimas para este flujo.
2. Crear los usuarios mediante el frontend o Supabase Auth. Obtener el UUID del
   usuario administrador desde el panel Auth. No usar la clave `service_role`
   como token de usuario ni compartir contraseñas con este backend.
3. En `.env`, configurar `SUPABASE_URL` con el origen del proyecto y
   `MERCHANT_ID` con un UUID estable generado una vez.
4. Configurar PostgreSQL en `DATABASE_URL` y `DIRECT_URL`, aplicar migraciones
   y provisionar la membresía desde una terminal de confianza en el servidor:

```powershell
pnpm db:generate
pnpm db:deploy
pnpm --filter @resolve-ai/contracts build
pnpm merchant:setup --user-id UUID_DEL_USUARIO --display-name "Mi comercio"
```

El comando crea el merchant si no existe y asigna/reactiva al usuario como
`ADMIN`. No restablece políticas ni el nombre de un merchant existente.
Para agregar un lector, usar `--role VIEWER`. La operación queda registrada
como `MEMBER_PROVISIONED_BY_OPERATOR`; requiere acceso directo al servidor y
a la base de datos. No existe endpoint público de autorregistro de miembros.
El operador debe proporcionar el UUID de una cuenta real del proyecto Auth.

5. Configurar `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET` de la misma app
   Sandbox asociada al merchant. Ambos son exclusivamente del servidor.
   `PAYPAL_WEBHOOK_ID` solo indica si hay un ID configurado: M02 implementará
   la recepción y validación. Reiniciar la API al cambiar el entorno.

Sin credenciales PayPal las consultas autenticadas funcionan y muestran
`NOT_CONFIGURED`. Sin Auth configurado, M01 falla cerrado; health sigue
disponible. La base no se modifica ni se hacen llamadas PayPal al arrancar.

## Contrato para frontend

Enviar el access token de la sesión Supabase:

```http
Authorization: Bearer <supabase_access_token>
```

Nunca utilizar un refresh token, una API key, credenciales PayPal ni un token
compartido. El frontend renueva la sesión con Supabase y reintenta cuando
corresponda; no envía `merchantId` ni un rol elegidos por el navegador.

| Método | Ruta                                      | Rol          | Resultado                                                  |
| ------ | ----------------------------------------- | ------------ | ---------------------------------------------------------- |
| GET    | `/api/merchants/me`                       | ADMIN/VIEWER | Merchant, rol y política                                   |
| PATCH  | `/api/merchants/me/settings`              | ADMIN        | Configuración actualizada                                  |
| GET    | `/api/settings/integrations`              | ADMIN/VIEWER | Último estado, sin llamadas externas                       |
| POST   | `/api/settings/integrations/paypal/check` | ADMIN        | Comprueba OAuth y lectura de disputas y persiste resultado |

El PATCH acepta únicamente `displayName`, `allowInvestigations`,
`allowSubmissions` y `requireMerchantApproval` (siempre `true`). Rechaza objetos
vacíos, tipos incorrectos y campos desconocidos. Las investigaciones y los
envíos están deshabilitados por defecto. Habilitar `allowSubmissions` solo
expresa autorización de política: no reemplaza la aprobación del caso, la
verificación de evidencia ni los controles de M08.

Los schemas y tipos están en `packages/contracts/src/merchants.ts`. Swagger
documenta las rutas y su requisito Bearer. Los errores siguen el formato común
`{ code, message, requestId }`. 401 indica autenticación ausente/inválida, 403
membresía/rol insuficiente, 409 credenciales PayPal ausentes al solicitar una
comprobación y 503 configuración Auth ausente. Errores de DB se sanitizan.

## Estados honestos de integración

El check solo llama al host fijo `api-m.sandbox.paypal.com`:

- `POST /v1/oauth2/token`, con Basic Auth y `grant_type=client_credentials`.
- `GET /v1/customer/disputes?page_size=1`, con el token obtenido.

`connectionStatus=CONNECTED` significa que OAuth entregó un token válido;
`disputesReadStatus=AVAILABLE` requiere además una respuesta de lectura válida.
Una lectura 401/403 se muestra como `DENIED`, incluso si OAuth funcionó.
Los errores de red, timeout, JSON o esquema no producen éxitos ficticios.
Un HTTP 201 del endpoint interno indica que se ejecutó y guardó el check:
el frontend debe inspeccionar ambos estados, no mostrar conectado solo por 201.

No se guarda ni se devuelve la lista de disputas, el token, el client ID o el
secret. Se persisten estados, hora, último código HTTP y `paypal-debug-id`
validado. El timeout limita el conjunto de dos peticiones y no hay reintentos
automáticos. Peticiones simultáneas comparten el check en curso dentro del
proceso. Un HMAC detecta rotación de credenciales e invalida el estado anterior.
`lastCheckedAt` es una observación histórica, no una garantía de acceso actual.
No hay ninguna operación de escritura de disputas ni permiso de envío probado.

## Controles y límites

- JWT: firma mediante JWKS de un origen fijo de configuración, issuer y
  audience `authenticated`, expiración, `sub` UUID y rol de usuario autenticado.
  No se aceptan tokens `service_role`, firmas HS256 ni usuarios anónimos.
- El rol de aplicación proviene de PostgreSQL, nunca de metadata del usuario.
  Se vuelve a consultar membresía activa en cada petición. Desactivarla bloquea
  inmediatamente el acceso. Revocar una sesión solo en Supabase puede tardar
  hasta la expiración del access token, porque la validación JWT es local.
- JWKS usa caché y timeout. Sin una firma verificable el acceso se rechaza.
- RLS sin políticas públicas en tablas de M01: no permitir acceso directo desde
  el cliente Supabase. El rol de conexión del backend debe ser propietario de
  las tablas o tener `BYPASSRLS`; nunca usar el rol `authenticated` para Prisma.
- Cambios de configuración y checks escriben un evento con el actor en la
  misma transacción. No se expone edición de eventos. La auditoría general
  y sus controles de inmutabilidad corresponden a M09.
- No hay multitenancy ni administración de usuarios por HTTP. La configuración
  admite un merchant; un usuario asociado a otro merchant es rechazado.

## Pruebas y verificación externa pendiente

`pnpm check` ejecuta pruebas de entorno, criptografía JWT con servidor JWKS
**MOCK**, permisos de rutas y cliente PayPal con respuestas **MOCK**.
`pnpm test:db` prueba JWTs firmados, membresías, roles, políticas, eventos,
RLS y persistencia usando PostgreSQL real. El check PayPal está simulado en esa
suite y no se presenta como una conexión real al Sandbox.

Para la verificación real faltan un proyecto Supabase con usuarios, la conexión
PostgreSQL correspondiente y las credenciales de la app PayPal Sandbox. Después
de configurarlos, iniciar sesión desde el frontend y ejecutar las cuatro rutas
para registrar el resultado real. Nunca copiar secretos a Git ni al chat.

Referencias oficiales:
[Supabase JWT](https://supabase.com/docs/guides/auth/jwts),
[claves de firma](https://supabase.com/docs/guides/auth/signing-keys),
[PayPal OAuth](https://developer.paypal.com/api/rest/authentication/),
[consulta de disputas](https://developer.paypal.com/api/customer-disputes/v1/disputes-list).
