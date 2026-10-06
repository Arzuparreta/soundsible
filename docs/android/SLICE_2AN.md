# S2an — Traspaso de salida NORMAL

El botón «Transferir reproducción» de cada equipo conectado delega al servicio.
NativeDeviceSession verifica un destino de la misma cuenta con socket activo,
publica la cola/posición nativas recientes y después llama a Core handoff. La
operación usa el worker serial del actor, sin bloquear el looper del reproductor.
El reporte periódico se aplaza mientras hay traspaso. No enviar una sesión
capturada por JavaScript ni un estado atrasado del refresco periódico.

La generación, identidad de cookie, perfil, socket/revisión del actor y futuro
pendiente acotan cada paso. Un cambio de cola/índice/preferencias/transport entre
la publicación y el envío cancela la operación. Logout/reset cancela la petición
y resuelve el futuro desconectado. Core pausa el origen al enviar al destino;
la pantalla no pausa optimistamente si falla la publicación/preflight.

DJ todavía no ofrece este botón: necesita serialización/restauración de su
workspace y ruta propios. No degradar una sesión DJ a NORMAL. Tampoco esta
vertical cierra Radio/pending catalog ni la paridad completa.

Aceptación: DevicesUi + DeviceSession4/0 HTTP/TLS,31.965s; runner exit0 y
APK/test APK normales sin CA temporal, JVM56/0 y lint pasan. Log
`/tmp/soundsible-outgoing-native.log`. UI210 archivos/1614 tests y typecheck pasan
tras añadir transfer en EN/ES/FR/ZH. Las traducciones FR/ZH se añadieron después
del runner nativo; no afirmar navegación física ni cuatro idiomas en WebView.

DevicesUiTest valida el botón real, dos apariciones/index/posición54s/shuffle/
repeat all recibidos por un socket Core remoto y pausa del servicio de origen.
El peer valida el contrato recibido, no decodifica audio; DeviceSession valida
por separado restauración/PCM en Android. Guest Live/DJ no se transfieren aquí.
