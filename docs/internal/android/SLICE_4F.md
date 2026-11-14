# S4f — Programa DJ y carátulas de Live

El host toma una observación coherente del reloj de salida nativo para elegir la
pista dominante, la segunda pista, las ganancias y el progreso de la transición.
Publica las fases y técnicas del protocolo Live compartido. La pausa conserva la
pista principal y retira la transición; el volumen local no cambia las ganancias
del programa. Audio recibido de otra sala nunca se anuncia como emisión propia.

Las carátulas privadas se cargan mediante ProgramArtwork, sin cambiar su política
de autenticación. Un worker separado publica miniaturas JPEG de hasta256KiB con
el token de host en Community. Cache y trabajo pendiente están acotados y ligados
a la sala/generation; un fallo espera60s antes de reintentar. No viajan cookies del
Core ni secretos a JS. Terminar/reset cancela las solicitudes de imágenes.

El oyente sólo acepta HTTPS en el origen Community seleccionado y dentro de
`/v1/artwork/<sala>/`. Rechaza redirects, otras salas, exceso de bytes y dimensiones
superiores a512px. Inserta la imagen validada en MediaMetadata para que la ruta
existente de notificaciones/MediaSession pueda decodificarla. Cambiar de pista o
cerrar la reproducción invalida resultados pendientes.

Aceptación: Host4/Listener2,6/0 en76.723s, Core HTTP/TLS. DJ real atraviesa el
relay con metadata de overlap; NORMAL publica su carátula privada y el guest
recibe una carátula pública decodificable en MediaSession. Otras salas/orígenes
se rechazan. Runner exit0; APK/test APK/JVM54/lint sin CA temporal pasan.
Ver evidence/s4f.json. La regresión Live UI/Relay/Input queda para el siguiente
bloque conjunto. Todavía no es paridad.

Siguiente: recuperación de peer/red, lease y long polling; cancelación durante
handshake y muerte de proceso. Después, cerrar los huecos de teléfono/DJ/Auto,
firma y regresiones completas. PR abierta para revisión manual, sin automerge.
