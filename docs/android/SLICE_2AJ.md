# S2aj — Registro nativo mediante invitación

El campo de conexión admite la dirección del servidor o su enlace de invitación
`/player/#/invite/<token>`. Sólo después de enviarlo explícitamente se configura
el origen HTTP/HTTPS con las mismas restricciones de transporte existentes.
No se guardan token, path ni credenciales del enlace como dirección del servidor.
Se rechazan userinfo, query adicional, rutas ajenas y tokens de forma inválida.

La APK consulta preview por transporte nativo y presenta usuario y contraseña
confirmada con PasswordFields compartido. Accept crea la sesión Core con nombre
de dispositivo Android; auth/state confirma propietario y establece el perfil
nativo antes de cargar su biblioteca. No recarga la WebView ni modifica la cuenta
anterior ante una respuesta de otra generación. Cancelar, invalidar el propietario
o desmontar el formulario cancela sus operaciones.

La UI aclara que se puede pegar un enlace. Una invitación usada/incorrecta muestra
la misma respuesta que web y permite volver al login. No se incorpora captura de
cámara: pegar un enlace usa el teclado/clipboard del sistema sin permisos nuevos.

UI completa208/1606 + TypeScript pasan antes del ajuste textual del hint. InviteTest
HTTP/TLS verifica creación real por administrador, alta mediante formulario,
rol miembro/perfil offline propio, biblioteca sin canciones ajenas, cookie nativa,
recreate conservando identidad y accept repetido400. Native2/0 HTTP/TLS (17.238s), runner exit0 + APK/test APK/JVM56/lint normales.
Inicial2/2 por helper esperando startup unconfigured con origen configurado;
corregidos waits, dirigido UI final5/0. Ver evidence/s2aj.json. Admin y multidispositivo quedan
separados en la matriz; esto no prueba controles remotos ni recepción OS de invite.
