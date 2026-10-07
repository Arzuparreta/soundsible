# S4e — Live visible y guest nativo

La app abre Live desde su navegación. La UI Solid manda al servicio los comandos
para emitir, renombrar, terminar, escuchar, pausar/reanudar, cambiar volumen, enviar
chat y salir de una sala. Cerrar el panel sólo retira observadores; no termina la
sesión ni depende de un timer JS para conservar emisión o audio.

El directorio se obtiene mediante `NativeLiveDirectory`, desde el relay HTTPS
seleccionado por el Core: JSON acotado, sin cookies del Core hacia Community, sin
redirects, worker limitado y resultados ligados a generation. El WebView mantiene
su política de bloquear JSON remoto. La UI refresca directorio visible y después
de mutaciones, sin solapar consultas. Una prueba ampliada descubrió la ruta de
fetch incorrecta y motivó este puente; no se relajó el interceptor del WebView.

`NativeCommunitySocket` conserva el guest en el servicio, recibe programa/chat/
presencia/fin y actualiza metadata MediaSession. Chat del guest y controles pasan
por el comando privado del mismo UID. La escucha oculta cola, letras, DJ y autoplay
como acciones de canción; la selección canónica sigue devolviendo a NORMAL.

Los extras y respuestas a JS eliminan tokens de host/publicación. Un401 observado
por acciones Core de Live devuelve autenticación expirada y limpia sesión/perfil;
la UI vuelve al login y retira biblioteca/panel. Los transportes Socket.IO permiten
long polling de20s sin el timeout de10/20s anterior; queda pendiente soak dirigido.

Ver `evidence/s4e.json` para pruebas/logs finales y procedencia de las fuentes.
El bloque combina aceptación Native Host/Guest/Relay/Input con UI real HTTP/TLS.
UI realiza emisión/título/chat/fin y directorio/escucha PCM/pausa/volumen/chat/salida;
la extensión comprueba login tras401. Unitarios completos y TypeScript acompañan
la validación. No sustituye Browser4 ni la regresión principal antes de la PR.

Pendiente Live: DJ completo al relay y metadata de transición, carátulas públicas,
recovery de media/red/lease, reset durante handshake y muerte de proceso. No hay
aceptación acústica de hardware, Bluetooth o coche. Tampoco habilita alpha, merge
ni publicación; la PR final queda para revisión manual.
