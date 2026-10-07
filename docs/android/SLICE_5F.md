# S5f: reconexión nativa de suscripciones

CarEventsTest2/0 HTTP/TLS, runner exit0; APK/test APK/JVM54/lint sin CA temporal.
[evidence](evidence/s5f.json) registra fuentes y duración. El cliente de producción
no cambia: sus reintentos existentes recuperan los cambios perdidos.

Con Activity destruida, el fixture cierra un transporte Engine.IO existente y
rechaza nuevos handshakes con503. Una edición de etiqueta no llega durante el
corte. La prueba espera observar un handshake rechazado; al restaurar red,
reconexión nativa refresca la etiqueta, conserva KEY/PCM y respeta unsubscribe.

Engine.IO procesa requests antes de hooks Flask; la denegación vive en middleware
WSGI exclusivo del fixture. Heartbeat2+3s sólo durante este test acelera detección;
se restauran25+20s al terminar. Los intentos iniciales no esperaban la detección
normal; no equivalen a fallo del cliente. Trazas temporales retiradas.

No valida agotamiento de los cinco reintentos, handover Android, DJ durante corte,
UID externo, host Google Auto ni audio físico. No paridad completa/release.
