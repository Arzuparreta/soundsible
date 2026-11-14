# S2au — Ajustes de servidor y de este dispositivo

Settings nativo gana las secciones de la web que faltaban: Biblioteca, Descargas
(sólo admin, como en la web), Comunidad y Acerca de; Dispositivos añade nombre de
este dispositivo y dispositivos emparejados (QR propietario reutilizado de la web).
Las vistas se extrajeron de `SettingsSections` como componentes compartidos
(`LibrarySettingsView`, `DownloadsSettingsView`, `CommunitySettingsView`,
`AboutSettingsView`); la web las usa con sus stores y Android con controladores
nativos acotados a cuenta/conexión.

Controladores nativos: cada await revalida identidad y conexión y aborta en cambio
de cuenta. Rescan sondea hasta completar y después sincroniza; repair exige
dry-run aceptado y confirmación; purge confirma; vaciar exige doble confirmación
con el número exacto. Descargas no es optimista: aplica sólo tras `updated` y una
relectura que lo confirma. Comunidad y versiones se leen del servidor; Acerca de
muestra versión/build de la app y versión del servidor (`/api/health`), mejor que
la etiqueta fija de la web.

Nombre del dispositivo: antes fijo «Soundsible Android». Ahora es por instalación,
por defecto el nombre del sistema (Ajustes → Acerca del teléfono) o el modelo,
renombrable desde Ajustes; la sesión conectada re-registra al instante y Core lo
ve sin reconectar.

SettingsServer HTTP/TLS: cuenta admin desechable; rescan real llena su biblioteca
y la fila muestra el recuento de Core; purge real (sólo metadata) devuelve 0;
vaciar se ejercita hasta la guarda de número sin enviar la petición; calidad de
descarga cambia y Core la confirma (restaurada al final); comunidad/versiones
coinciden con Core; renombrar llega a `/api/devices` y se restaura. No se ejecuta
vaciado real: retiraría audio compartido del fixture.

Bloque Settings+Devices+Connection 22/0 HTTP/TLS, 280.499s, runner exit0 +
APK/test APK/JVM56/lint normales. WholeUI213/1631 + TypeScript.
Logs `/tmp/soundsible-settings-server-native.log`,
`/tmp/soundsible-settings-block-native.log`; evidence/s2au.json.
Emparejar ESTE teléfono escaneando un QR (lado reclamante, como iOS) no existe en
la web y sería otra vía de autenticación: pendiente de decisión del usuario.
