# S6: offline y distribución

## S6a: Disponible sin conexión

[Decisión aprobada](OFFLINE_DECISION.md), 2026-10-03. Preparar archivos musicales
adquiridos desde menús de tres puntos de canción/colección. No hay acción de
preparación en el shell ni adquisición implícita de previews. Colecciones toman
sus miembros actuales, aunque el buscador local filtre filas visibles.

## Datos y transporte

OfflineStore (singleton de aplicación) usa SQLite en almacenamiento privado,
con metadata limitada por canción, estado, bytes/total, digest y ticket de intento.
Identidad ligada al origen y al id de cuenta confirmado en auth nativo; cookie
permanece en EngineConnection/Keystore, nunca cruza a JS. La UI no puede registrar
una cuenta offline ni suministrar rutas de archivo. Máximo 1.000 copias por perfil.
Playlists conservan miembros/duplicados y se filtran a archivos listos al desconectar.
Álbumes/artistas se derivan de metadata local; carátulas usan placeholder.

Un worker secuencial, una transferencia en vuelo, GET autenticado del stream local
del motor con origen privado/TLS y redirects rechazados. No llama a proveedores.
Cuerpos con longitud desconocida/incorrecta, sin duración reconocida o truncados
no se publican. Archivo .part, fsync, verificación multimedia y SHA-256 preceden a
rename y estado ready. Hash se revisa tras reinicio y cambio de mtime; longitudes
se comprueban también. Nombres derivan de SHA-256 del id, nunca de rutas de JS.

Sin evicción. Límite predeterminado 2 GiB, opciones 512 MiB/2 GiB/8 GiB; reserva
16 MiB de espacio real. Un fallo de espacio no borra otras canciones. Cancelar o
retirar invalida el ticket, cancela Call/cuerpo y elimina sólo los archivos propios.
Duplicados/colecciones solapadas comparten una copia por id. Logout/cambio de
servidor/cuenta y 401 observado eliminan perfil y cancelan preparación.

OfflineService dataSync sólo arranca por acción explícita con Activity en foreground,
con notificación localizada. Para al terminar la cola y gestiona timeout del SO.
No reanuda red automáticamente al arrancar: tras muerte de proceso los intentos
incompletos quedan interrupted y se limpian parciales/orphans. Retry es explícito.
SQLite conserva copias completas y metadata; no persiste el programa multimedia.
Referencia del límite de servicio: [Android](https://developer.android.com/develop/background-work/services/fgs/timeout).

## Programa y UX

OfflineDataSource resuelve un archivo completo al abrir el stream local, manteniendo
id/UUID/cola y el mismo ExoPlayer. El file URI nunca cruza JS. Range/seek los sirve
FileDataSource. Generación se comprueba también en lecturas; reset cierra el programa.
Con red, una copia completa explícita también se reutiliza sin transferir audio.
Sin motor, el arranque restaura el perfil verificado y la biblioteca disponible;
auth sólo se considera revocado cuando hay respuesta real 401, no por fallo de red.

Biblioteca contiene canciones/álbumes/artistas/playlists desde la misma superficie.
Su menú abre filtro «Sólo en este dispositivo» y gestión de espacio/progreso/fallos.
Menú de canción/colección ofrece preparación, marca de listo y retirada/cancelación.
Al desconectar sólo se activa una cola de miembros disponibles, conservando el
índice elegido y duplicados. Búsqueda remota/DJ/Live no se anuncian como offline.
No hay mutaciones diferidas ni sincronización inventada al reconectar.

## Aceptación

Pruebas de conversión/menús/overlay, APK/lint, ruta real de motor HTTP/HTTPS, lote
deduplicado, motor completamente inaccesible, reproducción/seek/pausa/cierre y
Activity recreation. Límites, cuerpo parcial/ inválido, cancelación y logout local.
El helper ejecuta una fase persistente, force-stop real del APK y otra fase offline,
comprobando hash y corrupción del mismo tamaño. Resultados en HANDOFF/evidencia.
La fase de reinicio se excluye de la suite principal y el helper la invoca con
argumentos propios; no ejecutarla suelta sin el protocolo de dos fases.
Se instalan APK y APK de tests una vez; `am instrument` ejecuta las fases y
`am force-stop` separa los procesos. Gradle connectedDebugAndroidTest desinstala
la app después de cada corrida y no debe usarse para ambas fases persistentes.
`scripts/android.py integration --offline-restart-only` repite únicamente ese
protocolo, conserva evidencia principal previa y no valida la suite principal.
La integración normal ejecuta primero toda la suite y después el protocolo.

La validación encontró un fallo previo en el proxy de previews WebM por HTTPS:
el mtime que contabiliza lecturas/LRU también generaba el ETag de send_file.
Un If-Range de Media3 dejaba de coincidir después de la primera lectura y recibía
200 con todo el cuerpo. La revisión de cada commit/remux de caché ahora genera
un ETag estable entre lecturas; Last-Modified no anuncia recencia como cambio de
contenido. Cachés antiguas conservan Range sin validator hasta reacquirirse.
Las pruebas cubren 206/304, reemplazo del mismo tamaño y entradas antiguas;
Los retries de programa 429/503 conservan presupuesto y cooldown. El transporte
permite un solo intercambio GET nuevo si un socket reutilizado desaparece antes
de recibir cabeceras (EOF); no aplica a conexión nueva, TLS/certificado, timeout,
cancelación, cuerpo parcial ni respuesta HTTP. No reanuda reproducción tras un
error observado ni añade retries de programa. Política cubierta por tests nativos.

S6a no habilita release. Mantener [gates](RELEASE_GATES.md) de paridad completa,
firma permanente y actualización; aceptación física de sonido/coche sigue separada.
