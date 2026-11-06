# Traspaso de la revisión de arquitectura (2026-11-05)

Punto de entrada para continuar sin el historial del chat. Recoge lo que se
encontró al recorrer el motor, la UI web, los clientes y el CI, qué se arregló y
qué queda. Actualiza la tabla de estado cuando cierres un punto.

Las comprobaciones se hicieron sobre `main` en `3c7e4af3`. Las marcadas como
**reproducido** se ejecutaron; las demás salen de leer el código.

## Estado

| # | Punto | Estado |
| --- | --- | --- |
| 1 | El editor de metadatos de la web saca la canción de sus playlists | **Cerrado** en la primera PR |
| 1b | Etiquetas de una cuenta copiadas al catálogo compartido del pool | **Cerrado** en la primera PR |
| 1c | Portadas manuales/retiradas compartidas entre cuentas | Corregido en la [entrega de portadas](2026-11-07-artwork-requests.md): overrides por cuenta; referencias históricas ambiguas preservadas |
| 2 | Detrás de un proxy, cualquiera en internet es administrador sin contraseña | **Cerrado** en la primera PR (ver residuo) |
| 3 | Socket.IO acepta cualquier origen | Pendiente |
| 4 | Cola de reproducción del servidor que ningún cliente lee; rutas stub | Pendiente, necesita decisión |
| 5 | Lógica de negocio en módulos de rutas y en el módulo Flask | Pendiente |
| 6 | JSON de estado escritos sin protección ante cortes | Pendiente |
| 7 | Actualización de yt-dlp con el módulo ya importado | Pendiente, no reproducido |
| 8 | Código muerto y detalles menores | Pendiente |
| 9 | Identidad musical acoplada a hash/vídeo y reconstruida en cada cliente | Implementado en PR #423; pendiente de CI e integración |

## Cerrado en la primera PR

### 1. Editor de metadatos de la web (reproducido)

`ui_web/src/components/MetadataEditor.tsx` usaba `/api/library/tracks/<id>/metadata`,
`/cover` y `/cover/none`. Las tres llamaban a `LibraryManager.update_track`, que
reescribía las etiquetas dentro del archivo: el hash cambiaba, el id también, y
se guardaba con `_save_metadata()` sin `id_replacements`. Resultado:

- las playlists seguían apuntando al id viejo, que ya no existía;
- `track_user_state` (reproducciones, valoración) no pasaba al id nuevo;
- la ruta marcaba `cover_source` sobre el id viejo, `_mark_track_metadata_updated`
  devolvía `False` sin avisar y la marca se perdía; «quitar carátula» incrustaba
  un PNG transparente de 1×1 en el audio;
- `update_track` subía y bajaba archivos del proveedor remoto con el bloqueo
  global `coordinated()` tomado.

Android ya usaba `/api/library/track-labels/<id>/…` (creadas por esto, ver
`docs/android/SLICE_2S.md`), que guardan etiquetas en `library.db` y la carátula
en el sidecar de artwork sin tocar el audio.

Arreglo: `ui_web/src/lib/api.ts` usa las rutas `track-labels`. Se borraron las
rutas antiguas (incluida `/cover/from-track`, sin clientes, y el parámetro
`cover_url`, que hacía que el servidor descargara cualquier URL sin límite de
tamaño), `LibraryManager.update_track`, `setup_tool/uploader.py`,
`shared/track_identity.py` y `AudioProcessor.update_tags`, que solo usaba esa ruta.
Consecuencia buscada: editar una etiqueta ya no cambia las etiquetas
incrustadas en el archivo descargado; eran privadas por cuenta igualmente.

### 1b. Copia de etiquetas al catálogo del pool

`_mirror_track_into_pool` (`shared/api/__init__.py`) copiaba al `library.json`
del pool las etiquetas editadas por cualquier cuenta. Con una cuenta es
necesario, porque ese archivo es su biblioteca. Con varias es el catálogo de la
instancia y `run_sync_task` lo vuelve a fusionar en la biblioteca del
administrador, así que la etiqueta de un miembro podía acabar en otra cuenta.
Ahora solo copia mientras `instance_has_multiple_users()` es falso.

### 2. Confianza por red detrás de un proxy (reproducido)

Con una sola cuenta sin contraseña y `advanced_mode` (lo activan `--daemon` y
Docker), `_legacy_trusted_network_allowed()` da el tipo `owner` con todos los
permisos a quien llegue desde una IP de confianza. Un proxy inverso local o
`tailscale funnel` hacían que todo llegara como `127.0.0.1`. Además
`startswith('100.')` confiaba en todo `100.0.0.0/8` en vez de `100.64.0.0/10`.
Con el cliente de pruebas de Flask, `GET /api/users` daba 200 desde `127.0.0.1`
con `X-Forwarded-For` público y desde `100.1.2.3`.

Arreglo en `shared/security.py`:

- `is_trusted_network` usa `100.64.0.0/10` y desenvuelve IPv4 mapeadas en IPv6.
- `request_client_address()`: si el par es de confianza y trae cabeceras de
  proxy, decide con la entrada **más a la derecha** de `X-Forwarded-For` (la
  que escribe el proxy más cercano), si no con el último `for=` de `Forwarded`,
  si no con `X-Real-IP`. `Tailscale-Funnel-Request` o un proxy que no nombra a
  nadie (`X-Forwarded-Proto`/`Host` sin dirección) dan `""`, en el que nada
  confía. Las cabeceras de un par que no es de confianza nunca se creen.
- La usan `get_request_auth_context`, la conexión Socket.IO, `is_safe_path` en
  playback y Subsonic, y `/api/downloader/config` (que con confianza mostraba
  las credenciales de la nube sin enmascarar).

Comportamiento de Tailscale comprobado en `ipn/ipnlocal/serve.go`: `serve`
**sustituye** `X-Forwarded-For` por la IP del par de la tailnet (sigue siendo de
confianza); `funnel` pone la IP externa y añade `Tailscale-Funnel-Request: ?1`.

**Residuo:** un proxy que no envía ninguna cabecera (Nginx sin
`proxy_set_header X-Forwarded-For …`) sigue pareciendo esta máquina. No hay
forma de distinguirlo; `docs/INSTALL.md` §5 ahora pide la cabecera y una
contraseña antes de publicar el motor. Quien usaba un proxy público sin
contraseña pierde por él los permisos de escritura y administración hasta que
ponga una.

## Pendiente

### 3. Socket.IO acepta cualquier origen

`_socket_cors_origins = "*"` (`shared/api/__init__.py`) mientras REST usa
`_build_cors_origins()`. Sin contraseña y en modo daemon, `on_socket_connect`
acepta el socket sin mirar la IP, así que una página cualquiera abierta en un
navegador que llegue al motor recibe `library_updated`, `downloader_*` y los
eventos de reproducción.

Cuidado al arreglarlo: en `python-engineio` 4.13, una **lista** de orígenes
sustituye a la comprobación de mismo origen (`HTTP_HOST` y
`X-Forwarded-Host`). Pasar la lista de REST rompería el reproductor servido en
`https://maquina.tailnet.ts.net` o tras un proxy. Hay que pasar una función
`(origin, environ)` que acepte el mismo origen (como hace engineio con `None`)
**o** los patrones de REST. Android nativo (OkHttp) no envía `Origin`, y engineio
no comprueba nada sin esa cabecera. Probar con los cuatro perfiles de
Playwright y con `tailscale serve`.

### 4. Cola de reproducción del servidor

`player/queue_manager.py` y `/api/playback/queue*`, `/shuffle`, `/repeat`,
`/next`: ningún cliente (web, Android, iOS) la lee. `docs/AGENT_INTEGRATION.md`
dice «This is the queue the browser player consumes», y no es así: lo que un
agente añade no suena. `GET /api/playback/next` modifica estado con un GET.
`/api/playback/play` responde siempre 404 y `/api/playback/toggle` siempre 500:
restos del reproductor de servidor eliminado. Decisión del usuario: borrar la
cola y sus rutas (y la sección de la guía de agentes) o conectarla a los
reproductores. Los dos stubs se pueden borrar ya.

### 5. Capas

`_resolve_candidates` es privada de `shared/api/routes/catalog.py` y la importan
`auto_mode.py`, `library.py` y `shared/migration/service.py`.
`shared/dj/session.py` importa `_dj_prepare_cohort` de `routes/auto_mode.py`.
`catalog.py` importa `_get_preview_stream_cached` de `routes/playback.py`. Los
objetos compartidos (`get_user_core`, `add_tracks_to_user_library`,
`emit_to_user`, `socketio`) viven en `shared/api/__init__.py`; por eso nueve
blueprints tienen su `_get_api()` con imports diferidos y
`shared/loudness/service.py`, `shared/migration/service.py` y
`shared/artwork_recovery.py` importan el módulo Flask. Mover esas funciones a
módulos de servicio es mecánico. Los tests sustituyen `_get_api` con
diccionarios: moverlas obliga a actualizar esos dobles.

### 6. Escrituras JSON no atómicas

`player/queue_manager.py` (`queue_state.json`), `shared/playback_state.py`
(en cada `PUT /api/playback/state`) y `shared/discovery_intelligence.py`
(`discovery_settings.json`) usan `write_text`. Un corte durante la escritura
deja el archivo truncado. `favourites_manager` usa ahora la colección SQLite (PR #423)
y existe `shared/atomic_file.py`. Si se borra la cola del punto 4, sobran dos.

### 7. Actualización de yt-dlp en caliente (no reproducido)

Con `YTDLP_AUTO_UPDATE`, `start_api` lanza `pip install --upgrade yt-dlp` en
segundo plano cuando `yt_dlp` ya está importado (comprobado: `import shared.api`
lo carga). La versión instalada trae `lazy_extractors.py`: al importar solo se
cargan 4 extractores, y el de YouTube se importa en el primer uso, desde los
archivos nuevos, junto al núcleo viejo en memoria. Arreglo: actualizar antes de
importar o reiniciar después de actualizar.

### 8. Código muerto y menores

- `gui.sh` solo imprime que el reproductor GTK se eliminó.
- 35 iconos en `desktop-shell/src-tauri/icons/ios` e `icons/android` que
  `tauri.conf.json` no referencia.
- `stream_local_track` devuelve la ruta absoluta en el 404
  (`shared/api/routes/playback.py`); `/api/health` oculta rutas a propósito.
- `docs/ARCHITECTURE.md` §5 todavía lista `<config>/download_queue.json`; la
  cola de descargas está en `instance.db`.
- Los límites de `rate_limit` usan `request.remote_addr`: detrás de un proxy
  todos los clientes comparten cubo. Podrían usar `request_client_address()`,
  con cuidado de no dejar que un cliente elija su propia clave.
- `get_request_auth_context` guarda el contexto en `g` sin tener en cuenta
  `allow_trusted_network`. Hoy no falla porque todos los llamadores pasan `True`,
  pero el parámetro no tiene efecto real.


## 9. Identidad de colección (PR #423)

El incidente «2 songs» con una fila mezclaba una referencia YouTube y un archivo
con hash: guardados deduplicaba sus fuentes, pero playlists buscaba sólo por
`track.id`. La PR sustituye esa arquitectura por elementos musicales estables,
relaciones de fuente persistidas y una única transacción de incorporación y
pertenencia. Web/Android/coche/iOS consumen la identidad sin retargetear audio
preparado u offline. Contrato, migración y aceptación en
[COLLECTION_IDENTITY](COLLECTION_IDENTITY.md). No cierra los puntos 3–8.
