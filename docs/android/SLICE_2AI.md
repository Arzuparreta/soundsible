# S2ai: recibir canciones compartidas

Android recibe `soundsible://open?shared=<cápsula>` mediante ACTION_VIEW y el
texto de un ACTION_SEND text/plain con un único enlace público compatible.
El parser compartido limita tamaño, campos, identidad de vídeo y metadata. No
acepta configuración de servidores, credenciales ni instrucciones de autoplay.
No se registra como Android App Link HTTPS verificado: abrir automáticamente
la página pública en la app todavía requiere la integración del puente público.

La selección pendiente tiene un token independiente de cuenta y permanece antes
del login. La interfaz muestra título/artista y permite cerrarla; reproducir o
abrir acciones requiere una cuenta activa y reproductor preparado. Recibirla no
cambia cola, posición ni pausa. Reproducir explícitamente busca primero una canción
canónica de la biblioteca de la cuenta; en su defecto usa la identidad preview
validada y deja al adaptador nativo construir la fuente, sin URLs recibidas.

El último intent prevalece sobre una lectura inicial demorada. Acknowledgements
por token no descartan un enlace posterior. Tras consumir la selección, recrear
la Activity no vuelve a ejecutar su intent inicial. La selección pública pendiente
se conserva en preferencias privadas; no guarda información del servidor.

Validación sobre `9450752c` dirty: Incoming2 + Share2, **4/0 HTTP/TLS**,
29.504s instrumentados; APK/test APK/JVM54/lint normal sin CA pasa. UI204/1595
+ TypeScript. Primer compile falló por nullable del test; el bloque siguiente4/2
reveló replay del intent inicial al recrear. Capacitor BridgeActivity.load lo
redespacha; corregido descartando sólo el despacho inicial de instancia restaurada.
La repetición4/0 conserva los intents posteriores. Ver [evidencia](evidence/s2ai.json).

Invitaciones, controles multidispositivo y aceptación real del puente público
siguen pendientes. AVD no acredita navegador/aplicación destinataria o dispositivo
físico. El canal continúa development y no es una alpha pública.

Seguimiento offline sobref0e02058 dirty: Incoming2/0 HTTP/TLS,19.214s,
normal APK/test APK/JVM54/lint sin CA y UI204/1595 + TS pasan. Copias nuevas
conservan youtube_id público validado; con APIs503 y Activity recreada, Play
resuelve member-track adquirido, sin preview ni adquisición automática. Copias
anteriores sin esa identidad necesitan preparación de nuevo para reconocer el enlace.
