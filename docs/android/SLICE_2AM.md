# S2am — Controles de dispositivos desde Android

La identidad de reproducción procede de PlaybackService mediante el bridge
SoundsiblePlayback, acotada a la generación nativa. Settings muestra el teléfono
como «este» y los equipos de la misma cuenta; pausa/reproducción/anterior/siguiente
se envían por HTTP autenticado a Core y llegan a sus sockets. No importar el
store/reproductor web para identificar Android: crearía otro dueño de audio.

Las órdenes se serializan por interacción; controles deshabilitados para equipos
sin socket. Peticiones/listener se cancelan al desmontar. Identidad/generación y
vida del componente impiden que una respuesta tardía muestre datos de la cuenta
anterior o lance una orden después del cambio. El listado se refresca en primer
montaje, por botón y cada10s mientras la pantalla está visible.

UI completa210 archivos/1613 tests y TypeScript pasan. DevicesUiTest valida los
botones reales de WebView contra un segundo socket Core autenticado HTTP/TLS;
aceptación combinada DevicesUi + DeviceSession4/0 HTTP/TLS,31.097s.
La primera prueba descubrió que `/api/devices` no exponía `socket_active`,
propiedad esperada por la UI web compartida: Core ahora la deriva de active_sid.
La reinscripción ya preservaba el socket; no atribuir el fallo a ella.
Tests Core15/0. Runner exit0; APK/test APK normales sin CA temporal, JVM56/0 y lint pasan.
Log `/tmp/soundsible-devices-final-native.log`. El traspaso de salida y workspace DJ/Radio siguen
pendientes: esta pantalla no los sustituye. Desarrollo, no release.
