# S4c — host Live propiedad del servicio

`NativeLiveHost` pertenece a PlaybackService. Crea una sesión mediante el Core
firmado, abre WHIP y el socket Community con transportes sin cookies del Core,
envía programa/pausa/posición desde el player nativo y mantiene un heartbeat
independiente de Activity/WebView. El controller del mismo UID dispone de
liveStart/liveStop/liveTitle/liveChat. Clientes externos no acceden a estos comandos.

Las credenciales permanecen en el servicio: la respuesta de inicio y los extras
MediaSession contienen sólo sesión pública, estado, programa y hasta cien mensajes.
El socket recoge actualización de sala/presencia/chat y cierra el publisher al
recibir session_ended. Reset de conexión y destrucción del servicio retiran captura,
peer/socket y transporte; fin explícito elimina la sala sin parar el programa local.

Aceptación dirigida: LiveHost HTTP/TLS + LiveRelay HTTP/TLS + LiveInput tres casos,
7/0,42.984s, runner exit0. Normal APK/test APK/JVM54/lint pasan sin CA temporal.
Log `/tmp/soundsible-live-host-controls-native.log`. Host prueba título y echo de
chat reales, metadata de canción/pausa, PCM recibido por relay, heartbeat con Activity
cerrada y fin de sala manteniendo KEY y reproducción local. El primer intento de
Host falló por comparar el ID de browse con el ID de programa; la aceptación usa
la identidad de ocurrencia retenida, sin modificar el producto para el selector.

Pendiente: controles UI, escucha nativa MediaSession, metadata de transición/DJ,
carátulas públicas, reanudación tras muerte de proceso y recovery de media red.
No hay prueba dirigida de session_ended/reset durante handshake ni de lease de
larga duración. Los siete casos no sustituyen la regresión principal ni hardware.
