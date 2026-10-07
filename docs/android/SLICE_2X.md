# S2x: adquisición de música y promoción de identidad

Library y Search ofrecen Download en menús de previews. No equivale a guardar
bookmark ni preparar copia offline. La cola reside en el motor, continúa sin la
Activity y usa endpoints reales de enqueue/status/retry/remove/clear. Downloads
muestra filas compartidas con web, fases/progreso/fallos y acciones confirmadas.
Clear queue retira pending/failed/interrupted, conserva downloading según contrato
actual del motor; trabajos activos tienen cancelación individual.

Intake transporta video_id, display metadata e identity_keys exactas. Intentos
concurrentes se coalescen por cuenta/video; no reencolar archivo adquirido ni job
activo. Confirmar accepted index/ID y rejected vacío antes de refresh. Respuestas
de cuenta anterior no refrescan perfil nuevo. Estado de cola se limpia con cuenta,
se refresca por downloader_update y polling visible mientras tiene jobs activos.

Adquirir un preview no reemplaza su ocurrencia/URI, ni inicia audio. Library y
Search usan claves compartidas (yt/lib/aliases) para conservar indicador activo
cuando el archivo llega con hash como ID. Sin coincidencia exacta no comparar por
título/artist. La siguiente selección explícita puede reproducir el archivo nuevo.

Fixture sustituye sólo _download_audio por bytes de MP4/WebM sintético y progreso
acotado/fallo/delay controlables por endpoint protegido loopback+header. Permanecen
reales process_video, lectura/tags, hash/store_track, queue checkpoint, pool y
transacción personal. Cancelar invalida el job: incluso una respuesta posterior
del proveedor no incorpora la canción. No afirmar que detiene transferencia remota
ni que se aceptó YouTube vivo. Nunca usar estos fixtures sobre biblioteca personal.

Python **un test end to end pasa**, /tmp/soundsible-s2x-backend.log: fallo/retry,
progreso, archivo adquirido MP4/hash y Range real, cancelación activa sin promoción,
owner no ve ni elimina job de member, no recibe sus archivos. UI **1.425/167 pasa**,
/tmp/soundsible-s2x-ui-final.log: coalescing/aliases/receipt/account y filas reales
con confirmación, más web previo compartido.

APK **dos casos HTTP/HTTPS pasan**, cero fallos/omitidos,
/tmp/soundsible-s2x-native-local.log. APK/test/unit/lint normal sin CA pasa. Fuentes assets preparadas dirty desde b364905. Comprobar
retry/acquired hash, preview pausado20s/keys/token preservados y marcador de archivo
adquirido; cancelar Search mientras proveedor activo sin promocionar fuente nueva.
Teardown elimina archivos adquiridos sólo de este fixture, restaura Saved y sesión.
También seleccionar explícitamente hash adquirido y comprobar ready/playing con
source local, sin HTMLAudio; detener programa antes de teardown. Primer intento
falló al salir de Search antes de resolver/aceptar el intake: el guard canceló la
acción. El test espera la aceptación real antes de navegar y cancelar proveedor
activo. Teardown además restablece delay/failNext para casos posteriores.

Pendientes: entidades externas/descubrimiento avanzado, importación CSV/Settings,
compartir/multidispositivo, DJ/Live/Auto, firma/update/release. Regresión principal
ampliada y browser cuatro perfiles antes del PR final; alpha sólo con paridad completa.
