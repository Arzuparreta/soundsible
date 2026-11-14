# S2at — Invitaciones recibidas del sistema y menú de ocurrencia pendiente

Un enlace de invitación del motor (`<origen>/player/#/invite/<token>`) compartido
como texto (ACTION_SEND) queda como propuesta: la app muestra el servidor y no
configura origen, cookie ni cuenta hasta que el usuario pulsa. Sin sesión, Conectar
abre el formulario nativo de S2aj. Con sesión, la tarjeta avisa de que usarla cierra
la sesión y detiene la reproducción; Cerrar conserva la cuenta, y sólo «Usar
invitación» hace logout/olvida servidor y abre el formulario. La web descarta el
token si hay sesión porque allí cada servidor es otro origen; en Android una app
equivale a un servidor, así que se ofrece la elección explícita en vez de copiar
esa limitación. Store nativo único latest-wins compartido con canciones; el lector
de canciones ignora invitaciones sin consumirlas y viceversa.

VIEW sólo llega con `soundsible://open`; ningún productor emite invitaciones en ese
esquema, así que no se añadió formato. VIEW de enlaces https requiere puente
público/App Links, pendiente.

Una ocurrencia de catálogo pendiente en la cola ya no se reconstruye como canción
de biblioteca: su menú ofrece sólo «Quitar de la cola». Sin el guard, la prueba
nativa observó DJ desde canción, borrar de biblioteca, offline, editar, favoritos,
playlist y compartir sobre la ocurrencia pendiente (fallo verificado y restaurado).

IncomingInvite2 + IncomingTrack2 + Invite2 + PendingQueueMenu2: HTTP/TLS8/0,
66.403s, runner exit0 + APK/test APK/JVM56/lint normales sin CA temporal.
WholeUI211/1620 + TypeScript pasan. Log `/tmp/soundsible-incoming-invite-native.log`;
evidence/s2at.json. Sin regresión principal/browser4 en este bloque.
