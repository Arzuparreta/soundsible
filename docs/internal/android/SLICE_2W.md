# S2w: letras temporizadas con programa nativo

LyricsPanel web pasa a ser adaptador de LyricsPanelView compartido, con current
track/time, identidad library/saved y seek inyectados. Android usa el mismo panel
sin importar stores ni audio web. Se abre desde Show lyrics en el menú de tres
puntos del programa; podcasts no ofrecen letras. Ventana con scroller propio,
seguimiento de línea y seek mediante IPC; cerrar no altera pausa/cola/posición.

Consultas existentes /api/library/tracks/<id>/lyrics y /api/lyrics conservan
contrato; aceptan AbortSignal. Panel cancela consulta/polling al cambiar canción,
quedarse sin canción o desmontar. Android cierra al cambiar cuenta o cerrar el
programa. Memo de metadata nativa evita volver a consultar al avanzar posición.
La línea actual expone aria-current además de su highlight visual.

UI completa **1.419 tests/164 archivos pasa**, /tmp/soundsible-s2w-ui-preview.log:
web previo, posición nativa sin refetch, seek al runtime y cambio de cuenta aborta
consulta pendiente. Assets Android preparados durante working tree desde 9bc041d;
no artifact limpio de release. Fixture cachea letras sintéticas por track/usuario
usando database real; no depende de LRCLIB vivo ni simula respuestas del bridge.

APK **dos casos HTTP/HTTPS pasan**, cero fallos/omitidos,
/tmp/soundsible-s2w-native-preview.log: buscar letras de track adquirido, pulsar línea20s,
comprobar posición autoritativa/highlight, pausa/keys/queueToken conservados,
sin HTMLAudio, cerrar ventana y Sign out sin panel/programa anterior.
Preview guardado usa metadata (no ID library), respeta sourceKind unverified y
muestra plain sin líneas temporizadas; ambos protocolos aceptados. Motor cache
real; proveedor LRCLIB vivo y combinaciones físicas no validadas. Fuentes finales
preparadas desde 9bc041d con dirty=true. APK/test/unit/lint normal sin CA pasa al terminar el helper.

Continúa matriz completa: biblioteca/Discover/adquisición/importación/Settings,
compartir/deeplinks/multidispositivo, DJ/Live/Auto, firma/update/publicación. Browser
cuatro perfiles y regresión principal ampliada antes del PR final.
