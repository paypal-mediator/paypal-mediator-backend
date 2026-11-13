# M01: invitaciones a equipos

El administrador crea una invitación desde Settings > Invitations usando el correo
y el rol ADMIN o VIEWER. El destinatario la consulta desde el dashboard, desde
Join a team o desde el enlace compartido. El enlace abre la aplicación y requiere
iniciar sesión con el correo invitado confirmado por Supabase Auth. El ID del
enlace no concede acceso por sí mismo. Las invitaciones vencen en siete días y
el administrador puede revocarlas.

## API pública

- `GET/POST /api/merchants/me/invitations`: listar las 100 invitaciones más
  recientes del equipo / crear `{ email, role? }`. Requiere ADMIN y selección de
  equipo mediante `X-Merchant-Id`.
- `POST /api/merchants/me/invitations/:id/revoke` y `/:id/resend`: revocar o
  solicitar otro correo. Sin parámetros de autoridad en el cuerpo.
- `GET /api/merchant-invitations`: pendientes del correo verificado actual.
- `GET /api/merchant-invitations/:id`: detalle para ese mismo destinatario.
- `POST /api/merchant-invitations/:id/accept` y `/:id/decline`: aceptar o rechazar.
  No requieren pertenecer previamente a un equipo. Aceptar devuelve el contrato
  público del equipo y su rol.

La identidad se consulta en `/auth/v1/user` después de verificar criptográficamente
el token. No se usan `user_metadata`, correos enviados por el navegador ni el
equipo seleccionado para autorizar al destinatario. La aceptación es transaccional,
idempotente para el mismo usuario y serializada con revocación. Una membresía ya
activa conserva su rol; una invitación no eleva sus permisos. El administrador
que originó la invitación debe seguir activo al aceptarla.

La tabla es propiedad de M01, tiene RLS sin acceso directo desde el navegador,
unicidad de invitaciones pendientes por correo/equipo y membresías únicas por
usuario/equipo. Los eventos se publican en auditoría M09 sin incluir el correo.
Si existen membresías duplicadas antes de migrar, deben revisarse explícitamente:
la migración nunca fusiona permisos automáticamente.

## Correo en Render

Render aloja el proceso de envío. Se necesita un proveedor externo y un remitente
autorizado. Los puertos SMTP habituales están bloqueados en instancias gratuitas;
se recomienda la API HTTPS de Resend.

Configurar como variables del backend en Render:

```dotenv
INVITATION_EMAIL_PROVIDER=resend
INVITATION_EMAIL_FROM=invitaciones@example.com
RESEND_API_KEY=replace-with-secret
INVITATION_APP_URL=https://paypal-mediator-frontend.onrender.com
INVITATION_EMAIL_WORKER_ENABLED=true
```

El remitente debe estar verificado por el proveedor. `INVITATION_APP_URL` debe
pertenecer a los orígenes CORS autorizados; producción exige HTTPS. Sin esa
variable se usa el primer origen CORS. Nunca se aceptan enlaces de retorno desde
el cuerpo de la solicitud.

Como alternativa para una instancia que permita SMTP, configurar proveedor `smtp`,
`SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (false para STARTTLS, true para TLS),
`SMTP_USERNAME`, `SMTP_PASSWORD` y `INVITATION_EMAIL_FROM`. Se exige TLS.

El outbox persiste intentos y leases, con un máximo de cinco intentos y backoff.
Resend recibe una clave idempotente por invitación/versión. SMTP con resultado
ambiguo queda UNCERTAIN y requiere revisión antes de reenviar. Reenvío manual:
espera mínima de un minuto, máximo 30 por equipo/hora; creación: máximo 30/hora
y 100 pendientes por equipo. Ninguna llamada de correo mantiene abierta una
transacción PostgreSQL.

`SENT` significa aceptado por el proveedor, no entrega confirmada en la bandeja.
Sin credenciales se conserva `NOT_CONFIGURED`: dashboard y enlace siguen
disponibles. Configurar un proveedor no reenvía automáticamente invitaciones
anteriores; el administrador debe solicitarlo. Revocar impide aceptar incluso
si un correo ya estaba en tránsito.

La creación de cuenta confirma su correo mediante Supabase. En el mismo navegador
se conserva temporalmente el ID de invitación; en otro dispositivo se debe abrir
de nuevo el enlace o usar Join a team. No se amplía la lista de redirecciones de
Supabase para aceptar destinos arbitrarios.

## Publicación y verificación — 13 de noviembre de 2026

Backend `ea7328c` y frontend `ed42d78` publicados en Render. Verificación real
con dos cuentas existentes y confirmadas en un equipo QA: crear, revocar,
rechazar, aceptar concurrentemente, listar una sola membresía y conservar el
rol VIEWER ante otra invitación ADMIN. El rol VIEWER no puede crear ni listar
invitaciones del equipo. El enlace exige el destinatario correcto; otro correo
recibe 404 y las invitaciones revocadas/rechazadas no permiten aceptar.

Chrome de escritorio y móvil ejerció el frontend publicado sin mocks: creación,
aceptación por enlace, selección automática del equipo, selección tras recargar
y ocultación de controles ADMIN al VIEWER. La suite local usa proveedores MOCK
explícitos; las verificaciones publicadas usan Supabase Auth y PostgreSQL reales.
El correo queda pendiente de credenciales y remitente Resend en Render.

La migración tolera un índice único de membresías ya existente solo si su
definición es correcta. Nunca elimina el índice ni fusiona miembros duplicados.
CI: 462 pruebas unitarias/HTTP, 235 PostgreSQL y 162 de mediación; frontend:
40 pruebas, lint, tipos y build. Ver [evidencia publicada](evidence/team-invitations-render-20261113.json).
