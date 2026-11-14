# S4g — Cancelación y recuperación de media Live

LivePeer permite invalidar de inmediato un handshake desde el looper del player.
Cancela las esperas SDP/ICE y las llamadas HTTP fuera del hilo principal. El
cierre nativo queda en su worker; DELETE de la resource tiene límite de2s. Las
Locations detrás de `/media/` conservan exactamente un prefijo y siguen ligadas
al origen HTTPS, sin credenciales en URL ni fragmentos.

Host y listener tienen hasta tres reintentos, con esperas de1/2/4s y deadline30s.
El listener conserva la intención de pausa/reproducción, volumen e identidad
MediaSession al sustituir el peer. Un cierre explícito o generation nueva cancela
el trabajo viejo; agotamiento termina el audio y deja el retry manual. El host
reconecta en la misma sala y sigue enviando heartbeat de pausa mientras recupera
media. Perder el socket de lease por10s retira el host para que no siga publicando
indefinidamente después de perder la sala.

El relay desechable ofrece controles estrictos de fixture para cortar un peer
real de MediaMTX por sala/rol, y una respuesta OPTIONS TLS que tarda10s. Estos
controles sólo existen en scripts/android_live_fixture.py, fuera de la aplicación
Community de producción. La aceptación ampliada corta publisher y listener;
mantiene el listener pausado durante recuperación y verifica PCM tras volver.
El handshake debe cancelarse en menos de3s sin excepción de red en main.

Validación:14/0 en148.745s, runner exit0, normal APK/test APK/JVM56/lint
sin CA temporal pasan. Ver evidence/s4g.json. Incluye la UI real y todas las
clases Live anteriores; no sustituye la regresión principal ni Browser4.
Pendientes: prueba de agotamiento/lease y long
polling, process death/resume409 y reset de servicio durante handshake. Después
se cierra la regresión final de Live y las filas restantes de teléfono/DJ/Auto.
No habilita merge ni publicación; la PR queda para revisión manual.
