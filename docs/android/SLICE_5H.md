# S5h: reproducción y revocación desde otro UID

CarExternalTest2/0 HTTP/TLS, runner exit0; normal APK/test APK/JVM54/lint sin CA.
[evidence](evidence/s5h.json) identifica fuente y duración. Sólo cambian tests.

El listener autorizado usa playFromMediaId desde otro proceso/UID. Su controller
observa ID canónico member-track y playing; el programa nativo produce PCM local
no silencioso. La URI opaca permite una segunda apertura antes de logout. Tras
clearSession/logout, el mismo UID y la misma URI ya no permiten una nueva lectura.
Se mantienen rechazo sin trust, decode real de PNG y escritura denegada.

Revocación no retira bytes ya recibidos ni descriptores abiertos. No Google Auto
host, DJ externo, handover/focus externo, escucha física ni paridad completa.
