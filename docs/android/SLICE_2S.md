# S2s: edición de biblioteca conservando audio e identidad

S2r confirmó la presentación/IPC sobre WAV. Las rutas históricas de edición
reescriben tags y pueden cambiar el ID basado en hash: Android necesita conservar
la fuente actual, cola, membresía y copias offline cuando cambia una etiqueta.

Contrato explícito nuevo: POST `/api/library/track-labels/<id>/metadata`, multipart
POST `/api/library/track-labels/<id>/cover` y POST
`/api/library/track-labels/<id>/cover/none`. Mismo scope de escritura, rate limit,
cuenta y writer coordinado. Metadata sólo acepta title/artist/album/album_artist,
texto limitado y null explícito únicamente para album_artist. Se guarda metadata
canónica; cover se valida y persiste en sidecar. No acceder ni reescribir audio.
Las rutas históricas mantienen su comportamiento para otros clientes.

Android exige confirmación `status=success`, `storage=library` e ID original antes
de refrescar y publicar metadata nativa. Motor antiguo responde 404 y el editor
conserva datos para reintentar; no hay fallback a rehash. Las copias ya preparadas
actualizan etiquetas, sin cambiar bytes/digest/tickets. Son cambios de biblioteca,
no exportación de tags nuevos dentro del archivo descargado.

Aceptación local: writer/artwork para siete formatos, payload inválido,
persistencia fallida sin publicar cover, guard de respuesta antigua/rehashed y
cambio de cuenta pendiente; APK sobre FLAC real con tags y WAV, HTTP/HTTPS,
SHA-256 de audio antes/después, metadata IPC, pausa/posición/keys y copia ready.
Fixture opcional reproducible:

```sh
SOUNDSIBLE_ANDROID_FIXTURE_AUDIO_FORMAT=flac \
  env 'ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class=com.soundsible.android.MetadataTest' \
  python scripts/android.py integration
```

Preparar assets con `python scripts/android.py prepare` después de cambios UI.
Valor por defecto del fixture es WAV; sólo admite WAV/FLAC sintéticos y un directorio
nuevo, nunca audio personal. Selector OS, cancelación APK extendida y demás filas
siguen pendientes. No llamar a estas pruebas paridad completa ni alpha.


Resultados: **1.409 tests / 161 archivos UI**, **66 Python** de writer/metadata/
artwork y **cuatro fixtures reales** pasan. APK FLAC HTTP/HTTPS: **dos tests pasan**,
WAV HTTP/HTTPS: **dos tests pasan**, incluyendo SHA-256 de audio antes/después, ID
y formato conservados, texto/cover/retirada, ocurrencias/pausa/posición y copia ready.
Logs `/tmp/soundsible-s2s-flac.log` y `/tmp/soundsible-s2s-wav.log`; build normal
sin CA temporal pasa tras cada recorrido. Ruff y diff correctos.

Los payloads de artwork se validan antes del writer; error de almacenamiento no
se convierte en "imagen inválida". La metadata se confirma antes de publicar el
nuevo sidecar; fallo previo conserva artwork anterior (un objeto sin referencia
puede quedar para mantenimiento). Guard de cuenta evita refresh/programa nuevos
al completar una respuesta de la cuenta anterior. No hay fallback de compatibilidad
que cambie la fuente. [Evidencia](evidence/s2s.json).

Instrumentación dirty/HEAD S2r previo, desarrollo. Próxima regresión completa
debe incluir MetadataTest; últimas browser completas siguen S2j y se repetirán
antes del PR acumulado. Selector OS no aceptado: el test sigue usando File sintético.
Continuar acciones de entidades/biblioteca y resto de matriz sin cerrar turno por
un checkpoint. No PR/main/release hasta paridad completa.
