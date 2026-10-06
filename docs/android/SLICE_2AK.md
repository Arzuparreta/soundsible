# S2ak — Personas y permisos administrativos nativos

Android ofrece Personas sólo a administradores dentro de Settings. Reutiliza
UsersPanel web con un proveedor explícito de cuenta y ownership, sin activar el
store de reproducción web. Lista usuarios, crea cuentas y enlaces de invitación,
fija contraseñas, habilita/deshabilita y elimina con confirmación como la web.

Las operaciones comprueban cuenta/ownership y vida del panel antes de iniciarse,
tras diálogos y antes de publicar respuestas o copiar una invitación. Desmontar
el panel invalida respuestas; la generación del bridge sigue protegiendo el
transporte. Si la conexión deja de estar disponible los controles Android quedan
deshabilitados. El servidor mantiene la autorización administrativa real.

UI completa209/1610 y TypeScript pasan. UsersPanel tests prueban proveedor nativo,
miembro sin solicitudes, confirmación tardía sin DELETE e invite tardío sin copiar.
UsersTest HTTP/TLS comprueba el panel real sobre cuenta admin persistida, creación
con PasswordFields, invitación, disabled confirmado por Core y navegación/API403
para miembro. Native2/0 HTTP/TLS (25.67s), runner exit0 + APK/test APK/JVM56/lint normales.
Evidencia en evidence/s2ak.json. Reset password/delete conservan acciones
compartidas y guards unitarios; no todas se accionan en esta aceptación Native.

No equivale a controles multimedia entre dispositivos: ese contrato requiere un
socket y dueño nativo en PlaybackService, además del listado/acciones en Settings.
Browser4 completo antes de PR cubre también el cambio del panel compartido web.
