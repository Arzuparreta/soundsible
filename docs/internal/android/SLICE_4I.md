# S4i — Reanudar sala y programa después de otro publisher/proceso

Un409 `session_already_active` de Core lleva a resume firmado de esa sala. Antes
de rotar tokens, Community consulta su API privada de MediaMTX y retira sólo el
publisher WebRTC cuyo path e identidad coinciden con el stream de su propietario
verificado. Un fallo de relay devuelve503 sin invalidar las credenciales vigentes.
La API de control sigue privada; no se expone una acción pública para cortar peers.

Resume invalida el host socket anterior y conserva sala, artwork y último programa.
El host nuevo continúa su secuencia desde el snapshot anterior. La limpieza nativa
incluye un `if_host_token` firmado: una operación tardía con el token anterior
recibe409 y no borra la sala del nuevo host. DELETE aplica también una condición
SQL para proteger la carrera con otra reanudación.

La continuidad de proceso se prueba en dos fases sobre la misma instalación:
prepare conserva una emisión del servicio, el runner hace force-stop y resume
comprueba PID diferente, cookie Core cifrada conservada, misma sala, secuencia
creciente y PCM independiente recibido por WHEP. Reanudar es explícito: el usuario
selecciona música y pulsa Go live; arrancar el proceso no publica por sí solo.

`android.py integration --live-restart-only` ejecuta sólo ese protocolo con relay
aislado y conserva resultados aparte de la regresión principal. La principal
excluye el test bifásico y después ejecuta ambos protocolos offline y Live sin
reinstalar ni recompilar entre prepare y el reinicio de cada uno.

Core19/0; LiveResume HTTP/TLS2/0 (16.256s); reinicio prepare1/0 (5.935s) y
resume1/0 (5.277s) aceptados. Ambos runners exit0 y APK/test APK/JVM56/lint
normales sin CA temporal. Evidencia: `evidence/s4i.json`.
Todavía faltan reset/agotamiento/foco dirigidos y regresión final de Live, además
de las filas restantes de teléfono/DJ/Auto/firma. PR sólo para revisión manual.

Contrato del relay fijado por el deployment: [OpenAPI MediaMTX](https://raw.githubusercontent.com/bluenviron/mediamtx/v1.19.3/api/openapi.yaml).
Corrección de documentación anterior: Community envía ping cada20s y permite25s
para pong. La prueba silenciosa de35s cruza el intervalo20, no25.
