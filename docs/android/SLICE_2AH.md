# S2ah: compartir canciones desde Android

El menú compartido de canción (biblioteca, catálogo resuelto y cola/ruta) ofrece
«Compartir». SharePlugin abre ACTION_CHOOSER/ACTION_SEND text/plain; no adjunta
archivos, URIs de audio, cookies, origen de la cuenta ni permisos de archivo.
Música con identidad de vídeo usa la cápsula pública en fragmento de trackShare,
como web; música local sin esa identidad y podcasts comparten título/artista.
La metadata textual se acota antes de cruzar IPC. No se afirma entrega al receptor:
`opened` sólo confirma que Android aceptó abrir el selector.

La acción mantiene scope de cuenta/generation y requiere ventana activa. Un menú
viejo no migra a otra cuenta; validación nativa rechaza generation anterior y URL
con credenciales/query/fragmento no compatible. Compartir metadata no requiere
volver a conectar una cuenta que conserva su biblioteca offline.

Validación sobre `23c5c416` dirty: Share2 + LibraryActions2 + DjContext2,6/0
HTTP/TLS,57.095s instrumentados; APK/test APK/JVM54/lint normales sin CA pasan.
El monitor de instrumentation intercepta el Intent de Android: prueba menú/plugin/
payload y rechazo, sin enviar a aplicaciones destinatarias. UI201/1584 + TS.
Logs y límites en [evidencia](evidence/s2ah.json).

No cierra compartir/invites/deep links ni paridad de teléfono. Recepción de
cápsulas, intents frío/caliente, invitaciones y multidispositivo siguen pendientes.
Comprobar selector y receptor real al hacer aceptación manual; no confundir el
monitor con esa aceptación. El canal sigue siendo development, sin alpha pública.
