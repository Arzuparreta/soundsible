# Arquitectura y contratos del port Android

## Fuente y alcance

Base inspeccionada para preparar el port:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02. Revisar los símbolos actuales
antes de cada slice: el commit es una referencia histórica, no un pin perpetuo.

Capacitor empaqueta assets locales de Solid y proporciona el puente a Android.
La configuración vive en `ui_web/capacitor.config.json` para resolver dependencias
desde el único package/lockfile del cliente. El proyecto Gradle se conserva en
`android/`; `cap sync` genera sus enlaces a plugins. No introducir otro frontend,
una copia de las pantallas ni un segundo lockfile JavaScript.

## Fundación S0 (referencia histórica)

- Entrada `ui_web/src/mobile/main.tsx`: preferencias visuales, locale y arranque
  compartidos; no importa sesión, stores, socket, audio o Community.
- `AndroidStart` usa el logo, tokens y diccionarios del cliente. Sin formularios
  que aparenten conectar ni botones de características inexistentes.
- `nativeBuildInfo()` exige Android y consulta el plugin nativo `App.getInfo`.
  Expone plataforma, applicationId, versión y build; un fallo no inventa éxito.
- `vite.android.config.ts` reutiliza el HTML y plugin de arranque web, cambia la
  entrada y base relativa, y excluye publicDir/PWA. La salida está aislada.
- `MainActivity` es una `BridgeActivity` Kotlin. No hay aún servicio multimedia,
  descargas, transporte de cuentas o permisos de cámara/micrófono.
- Android exige TLS para tráfico de red en esta entrega y declara `allowBackup=false`. Las reglas de transferencia y
  almacenamiento de credenciales deben verificarse en S1. HTTP LAN necesita una implementación explícita en el slice de conexión.

Los atributos de metadata en el elemento de montaje existen para probar el
puente. No transportan credenciales ni constituyen un nuevo protocolo servidor.

## Conexión y autenticación: diferencias que no deben ocultarse

| Contrato actual | Fuente y consecuencia para Android |
| --- | --- |
| `apiOrigin()` usa el origen de la página | `ui_web/src/lib/config.ts`; el origen local del paquete no es el motor remoto. |
| REST lleva cookies `same-origin` | `ui_web/src/lib/http.ts`; cambiar sólo la URL no preserva sesión. |
| Sesión de usuario, roles y namespaces | `ui_web/src/lib/session.ts`, `shared/api/routes/auth.py`; no montar stores antes de saber la cuenta. |
| Cookie HttpOnly, SameSite=Lax | Login del servidor; CORS con credenciales por sí solo no resuelve un WebView local. |
| Socket.IO abre contra `apiOrigin()` | `ui_web/src/lib/socket.ts`, `shared/api/__init__.py`; autenticarlo como la misma cuenta que REST. |
| Emparejamiento y scopes | `shared/api/routes/pairing.py`, `shared/hardening.py`; no asumir que `library:read` habilita toda la app. |
| Cliente iOS navega el contrato de coche | `ios/SoundsibleKit/`, `/api/car/*`; no cubre por sí solo descubrimiento, adquisición, edición y Live. |

El primer slice mantiene login de cuenta como contrato del cliente completo. El
transporte nativo debe mantener sesión y recursos autenticados en el contexto de
la instancia seleccionada. Probar cookie jar, Socket.IO y streaming como un único
camino antes de generalizar el adaptador. El emparejamiento es complementario;
no convertir un token limitado en owner/admin ni desactivar autorización para
hacer funcionar la UI. Nunca poner contraseñas o tokens en query strings, logs,
metadata, preferencias web en claro ni URLs compartidas.

Inventariar URL de REST, Socket.IO, cover, preview, podcast stream y audio al
conectar: rutas relativas deben resolver contra el motor; enlaces externos no
reciben su credencial. Preservar cancelación, timeouts, multipart, Range, ETags,
401/403 y aislamiento de cuenta. Tras cambiar servidor/cuenta cancelar trabajos
anteriores y limpiar caches, playback y socket antes de montar el siguiente.

## Decisión de transporte S1

`EngineConnection`/`EnginePlugin` implementan REST y Socket.IO con OkHttp y el
cliente Java [Socket.IO](https://github.com/socketio/socket.io-client-java).
El plugin local usa el [puente Capacitor](https://capacitorjs.com/docs/android/custom-code).
No cambia CORS, SameSite ni autenticación/scopes del motor. No añade bearer/owner.
`sb_session` se obtiene del `Set-Cookie` HttpOnly y se conserva en memoria y en
preferencias privadas cifradas AES-GCM con una clave no exportable de Keystore;
`allowBackup=false` evita exportar esa sesión. La dirección se guarda sin secreto.
El puente sólo devuelve status, cuerpo y ETag/Content-Type/Content-Range de REST;
no devuelve Set-Cookie. Logging Capacitor está desactivado para no registrar login.

`http.request` conserva su fetch web y permite instalar un transporte desde la
entrada nativa. `mobile/engine.ts` serializa JSON/multipart, propaga timeout/abort,
reconstruye status/ETags y descarta respuestas de generaciones anteriores. Cancelar
antes de que el executor registre la llamada también queda registrado en Kotlin.
304 y 401/403 conservan sus significados. No hay cambio de API de producción.

Android **bloquea cleartext por defecto**. La única excepción OS es el alias
reservado `soundsible-private.invalid`; el transporte reescribe internamente HTTP
hacia ese alias, mantiene el `Host` original y resuelve exclusivamente las IPs
privadas de la instancia seleccionada. La resolución está capturada por cliente,
no puede saltar a otro servidor al cambiar la selección. Incluye RFC1918,
loopback, ULA IPv6 y Tailscale 100.64/10. No se aceptan redirects; para HTTPS no hay
alias ni excepción de certificados. La WebView carga assets locales, nunca una
página remota con el puente; imágenes externas se leen sin cookies ni headers de
cuenta (HTTPS, máximo 8 MiB y timeout). HTTP externo no recibe la excepción LAN.

Las carátulas autenticadas se resuelven como
`https://localhost/__engine/<generación>/api/static/cover/<id>`. MainActivity
intercepta sólo ese recurso, verifica la generación, usa la misma cookie nativa y
responde `no-store`. No hay cache de imágenes compartida entre cuentas. El socket
usa el mismo cliente/cookie y sólo remite nombres de eventos con generación, sin
payloads personales. Logout/cambio destruyen socket, cancelan llamadas, desmontan
la biblioteca y limpian metadata; cualquier callback tardío comprueba su época.
La identidad se revalida antes de cada refresh y al volver a primer plano.

La UI conectada es una superficie **de lectura de desarrollo**:
`mobile/LibraryBrowser`, la fila compartida `MusicListRowView`, virtualización,
carátulas y diccionarios existentes. `musicLibraryRows` comparte la selección y
orden por recencia de archivos y canciones guardadas con la biblioteca web;
los helpers de identidad evitan duplicar canciones promovidas. `MusicListRow` sigue siendo el adaptador de
cuenta/playback web sobre esa misma vista. No se importa `stores/index`, audio o
Community desde Android. Los botones de canciones anuncian `aria-disabled`;
las colecciones sí navegan. Esto no representa paridad de acciones: al integrar
S2 se debe conectar la UI completa al runtime nativo, evitando un fork permanente
de Library. Búsqueda aquí sólo filtra la biblioteca propia; no es descubrimiento.

La integración instrumentada usa tres instancias reales desechables; cubre HTTP y HTTPS,
roles, cookie/artwork/socket, persistencia cifrada, revocación, generaciones y
passwordless. El fixture HTTPS usa una CA generada para esa ejecución y SAN IP
correcto; Android/OkHttp verifican cadena y hostname con el trust normal más esa
CA efímera en un override debug generado. Las claves viven en TemporaryDirectory,
la CA pública/config debug se ignoran en git y se eliminan siempre; al terminar
se recompila el APK normal sin la CA de prueba. Release jamás la incorpora.
El rechazo de TLS incorrecto y el happy path están probados en ese motor real.
La instancia HTTPS pública concreta y DNS/Tailscale/red/dispositivo reales siguen
como aceptación de despliegue pendiente; no son lo que prueba la CA del fixture.


## Audio: un programa, un propietario

Referencia: `ui_web/src/lib/audio/contracts.ts`, `audio.ts`, `audio/transport.ts`,
`audio/graph.ts`, `audio/mixer.ts` y stores NORMAL/DJ. No basta con enganchar Play
al `ExoPlayer` manteniendo el mezclador web activo en paralelo.

El servicio multimedia nativo será dueño de reproducción y estado autoritativo,
incluso con UI suspendida. Solid comparte intención, navegación y planificación;
comandos y eventos del puente reconciliarán snapshots con generaciones para no
aplicar confirmaciones viejas tras cambiar de canción, seek o pausa.

La interfaz `AudioService` actual contiene operaciones síncronas, snapshots y
captura `MediaStream`: un puente asíncrono no puede suplantarla devolviendo éxitos
falsos. Delimitar/adaptar esos contratos con pruebas antes de sustituir el runtime.
Los eventos del sistema deben pasar por el mismo estado que los controles Solid.

[Media3](https://developer.android.com/media/media3/session/background-playback)
aporta sesión, servicio, decodificación y controles, pero no implementa nuestros
EQ, filtros, echo, limiter ni todas las técnicas DJ. Antes del slice DJ, probar
una mezcla real de dos fuentes autenticadas y su captura PCM. Registrar la
solución elegida y su coste; no prometer que dos ExoPlayers equivalen al grafo.
Preservar rutas por `queueId`, recuperación bounded y audio saliente durante
fallos de preparación. El scheduler de transiciones no puede depender de timers
JavaScript cuando la WebView esté suspendida.

## Live y coche

`ui_web/src/lib/community.ts`, `audio/capture.ts` y `docs/LIVE.md` definen que
Live toma el programa **después de mezcla/efectos/limiter y antes del volumen y
mute locales**. El programa nativo necesita ese mismo punto de captura y un
camino probado hacia el relay/WebRTC. Escuchar otra sala no debe reemitirla.
La UI «On air» no es prueba de audio recibido: validar con un listener separado.
Declarar y probar las condiciones de primer/segundo plano, sin atribuir a la web
una continuidad de emisión que hoy no garantiza.

Android Auto requiere `MediaLibraryService`/`MediaSession`, navegación segura del
árbol `/api/car/*` y controles acordes con la cola. No renderizar el workspace DJ
libre en el coche. La existencia del servicio o un emulador AAOS no prueba Android
Auto: [DHU](https://developer.android.com/training/cars/testing/dhu) sigue requiriendo
un teléfono compatible con Android Auto. Registrar ese gate físico por separado.
Una aplicación AAOS instalada en el coche es otro paquete/entrega, fuera del port
móvil inicial; no confundir AAOS con Android Auto.

## Mantenimiento compartido

Un cambio Solid relevante dispara build Android desde las mismas fuentes. Los
adaptadores específicos reciben pruebas de contrato; evitar condicionales de
plataforma dispersos por pantallas. Actualizar conjuntamente core/CLI/Android,
comprobar compatibilidad de plugins, fijar dependencias y mantener Gradle Wrapper
verificado. La versión comercial viene exclusivamente de `shared/version.py`
mediante `scripts/version_sync.py --print`; no copiar una versión en Gradle.


## Programa nativo S2a

`EngineConnection.shared` comparte el origen/cookie/generación en el proceso.
La Activity libera su socket y MediaController, conservando el servicio de audio.
`PlaybackService` contiene ExoPlayer/MediaLibrarySession y un cliente OkHttp por
época; los listeners de reset cancelan ese cliente y vacían el programa.
Las fuentes tienen una generación interna en su URI, retirada antes del HTTP;
una fuente antigua no puede adoptar la nueva cookie aunque se reutilice el origen.
Range sigue el DataSpec de Media3. No hay cache de audio ni redirects autenticados.

`PlaybackPlugin` construye ids/metadatos/URLs nativos, valida comandos contra la
generación y expone snapshots; resolver command no afirma audio audible. JS no
recibe cookie ni URL autenticada. Estado playing procede de ExoPlayer y metadata
procede de MediaSession. Un callback de estado de otra generación se ignora.
Los controladores externos deben ser trusted; sólo el UID propio reemplaza cola.

La Activity observa; no contiene el player ni lo detiene al desmontar Solid.
Al pasar a background se pausa el ticker de JS; foco/noisy/foreground/notificación
pertenecen a Android. Logout y cambio sí paran el programa. HTTP 401 se expone
como status para revalidar identidad; otros fallos no afirman reproducción y
permiten un retry explícito. Fuente/id/posición están sujetos a la cuenta actual.
No hay persistencia del programa tras process death ni navegación Auto implementada.
Ver [contrato/continuación](SLICE_2.md) y [evidencia S2a](evidence/s2a.json).

### Contrato asíncrono implementado en S2c

`ui_web/src/lib/program/runtime.ts` separa comandos tipados y snapshots de una
salida de los contratos síncronos de mezcla. `mobile/playback.ts` aporta el
adaptador Capacitor y `components/ProgramTransport.tsx` observa el estado para
renderizar transporte/seek/modos. AndroidStart ya usa este camino. Orden de
snapshots por generación y secuencia, comandos serializados, limpieza de callbacks
y pending de aceptación quedan probados sin instanciar audio en JS.

No sustituye todavía stores/actions de NORMAL ni monta AuthenticatedPlayer; esas
rutas deben adaptarse al contrato antes de retirar LibraryBrowser. No interpretar
la disponibilidad de un componente en `components/` como migración del navegador:
la UI web conserva su runtime actual. Véase [S2c](SLICE_2.md#s2c-runtime-asíncrono-y-transporte-solid).

### Cola por ocurrencias de S2d

ProgramQueue observa entradas nativas con UUID por ocurrencia. El puente envía
select/move/remove con generación, índice, clave y huella del orden; PlaybackService
valida su cola real al recibir el custom command antes de editarla. Sólo concede
ese comando al UID de la app; no recibe URI/cookie de JS. Los controles Solid y OS
continúan observando un único player. Virtualización con clave estable y medición
real de cada fila evita reconstruir DOM con los ticks o solapar controles en edición.
El seek sigue la clave actual, conservándose al moverla y limpiándose al sustituirla
por otra entrada del mismo id e índice.

### Inserciones desde biblioteca de S2e

El mismo custom command añade append/insertAfter. Las fuentes y UUIDs se crean en
el servicio desde metadatos; el límite total y el lote se validan antes de mutar.
insertAfter guarda y valida la ocurrencia actual además del orden, para rechazar un
menú abierto antes de una transición OS. La selección diferida no cruza cuentas.
No hay reconstrucción del programa ni autoplay al llenar una cola vacía.
El menú y sus outlets reutilizan la presentación compartida sin stores de mezcla.
[Contrato y semántica shuffle](SLICE_2.md#s2e-añadir-desde-biblioteca-y-colecciones).

### Recuperación explícita del programa de S2f

playing e intención playWhenReady son estados distintos del player. El error se
clasifica nativamente; retry usa el custom command restringido al UID y guards de
época/orden/ocurrencia, validando también el error actual del servicio. prepare
conserva el programa y respeta la intención actual sin reconstruir fuentes.
Audio no reintenta de fondo ni se reanuda por una señal genérica de red.
La UI puede observar el servicio durante fallo de revalidación de identidad sin
inventar una cuenta autenticada. Un 401 limpia también ese estado; un 403 no se
convierte en logout. [Contrato S2f](SLICE_2.md#s2f-recuperación-explícita-de-conexión).


### Artwork del programa (S2g)

La metadata nativa lleva una URI interna creada desde id/generación, nunca una URL
aportada por JS. `ProgramArtwork`, instalado como BitmapLoader de la sesión, descarga
la miniatura autenticada mediante EngineConnection y entrega el bitmap al proveedor
estándar de notificación/metadata Android. Concurrencia, bytes, dimensiones y tiempo
están limitados; el único resultado retenido es el último de la generación activa,
sin cache de disco. Reset cancela tanto future como Call antes de la cuenta posterior.
Errores de imagen no se propagan al player ni borran login.
La UI de programa/cola usa el proxy local privado existente y el gradiente compartido;
el proxy ahora limita bytes y revalida generación antes de publicar. Ver
[contrato y límites S2g](SLICE_2.md#s2g-carátulas-privadas-del-programa-y-sesión).


### Cierre de programa (S2h)

`stop` pasa por el custom command del servicio, con guard de UID/generación y
programToken; funciona sin REST/cookie. El programa recibe una identidad UUID al
reemplazar la cola o insertar sobre una vacía; append/inserción/refill/edición de
metadata y navegación la conservan en los extras de cada ocurrencia. El orden
tiene su queueToken separado. Así un refill no veta el cierre, pero una orden
capturada antes de abrir otro programa no lo cierra. Para callers sin
programToken se mantiene la validación antigua de queueToken; nunca inferir el
programa actual para una orden atrasada. Las ediciones de filas mantienen token/key.
Closure y Autoplay HTTP/HTTPS prueban ambas identidades y generación antigua.
La primera corrección sólo por generación pasó Autoplay pero falló Closure;
está sustituida por esta identidad estable y no representa el contrato final. El
servicio vacía fuentes, intención/modos/error y recursos de audio/artwork. El plugin
espera el estado cerrado recibido por IPC antes de resolver. No cambia identidad;
una cola nueva no hereda intención/modos ni claves. Media3 retira la notificación
por timeline vacío, manteniendo el player/session mientras existan controllers.
[Contrato S2h](SLICE_2.md#s2h-cierre-explícito-del-programa).

### Copias explícitas del teléfono (S6a)

OfflineStore pertenece a la aplicación, no a la Activity. SQLite y archivos
privados guardan sólo copias completas de música adquirida y metadata limitada,
ligadas al origen y cuenta que confirmó el transporte nativo. OfflineService
ejecuta preparación explícita en foreground; generación/tickets cancelan resultados
obsoletos. OfflineDataSource entrega el archivo verificado al mismo Media3 y
preserva Range/seek. No hay un segundo motor ni file URI/cookie en JavaScript.
La biblioteca local se deriva de esas copias; logout/cambio/401 observado eliminan
perfil y trabajos. Ver [contrato, límites y aceptación S6a](SLICE_6.md).


### Importación nativa S2y

MigrateView comparte jobs/guía/controles con web sin stores de audio; el adaptador
Android usa ACTION_OPEN_DOCUMENT y POST normal /api/migration/jobs. Se transporta
un token opaco de un solo uso, nunca content URI ni bytes/base64. ImportFiles liga
grant a generación, perfil y fingerprint de sesión, con TTL y lease cancelable;
ImportStreamBody limita100MiB y chunks64KiB. Consulta de metadatos fuera de UI,
workers/cola acotados y CancellationSignal/deadline120s; upload120s. El parser
valida formato/bytes tras elegir documento de MIME application/* o text/*.
Scope de vista abortable e irrevocable, poll coalescido y revisión de mutaciones
protegen cuenta/progreso. La dirección para continuar en ordenador es el origen
real del motor, nunca localhost del paquete. Ver SLICE_2Y y HANDOFF para evidencia
local y límites: no afirmar exports reales/cloud ni paridad completa por CSV.

### Retirada confirmada y recuperación local (S2aa)

DELETE + snapshot privado sin archivo preceden `retireSource` y retirada offline.
El comando global por fuente exige UID/generación; no usa un orden efímero de
cola. Rangos locales inversos preservan keys/identidad del programa y previews.
Radio/autoplay cancelan plan pendiente y excluyen IDs locales retirados. El
bridge resuelve sólo tras observar ausencia; vacío exige cierre del programa.

Offline invalida ticket y marca error recuperable antes del filesystem. Fallos
conservan fila/bytes retenidos para quota y muestran retirada fallida, con
recuperación desde el gestor. Una copia cuyo archivo se retiró desde otro cliente
no se purga automáticamente: metadata local del mismo perfil permite cleanup
confirmado por GET incluso si DELETE devuelve 404. Ver SLICE_2AA para evidencia
y límites; S2ab acepta respuesta real deliberadamente retrasada en Radio y autoplay HTTP/HTTPS.


### Cuenta e historial compartidos (S2ac)

AccountSettingsView recibe usuario/acciones sin runtime de audio; Android confirma
receipt y auth/state no-store dentro de la misma identidad y scope abortable.
Cambios de password conservan cookie en transporte nativo/Keystore. UI no publica
cookies. Logout respeta busy del bootstrap y confirma antes de cerrar.

SearchHistoryStorage comparte semántica con web e inyecta namespace Android por
origen/cuenta. Sólo respuestas vigentes recuerdan consultas; desactivar elimina
ambos dominios del perfil, sin afectar otras cuentas. Recientes se pueden ejecutar
y retirar. Ver SLICE_2AC para aceptación HTTP/HTTPS y límites.


### Apariencia y preferencias visuales compartidas (S2ad)

AppearanceSettingsView y DisplayPreferencesView reciben valores/acciones, sin
importar stores de audio. Adaptadores web conservan controladores existentes;
Android usa createNativeAppearance con tabla de temas boot y persistencia visual
compartida. Tema/tamaño/contraste pertenecen a la instalación, no al perfil del
motor. Idioma usa los diccionarios compartidos.

SystemBars integrado conserva estilo de iconos ante configuración del SO.
SoundsibleAppearance sólo admite colores hex de la paleta para fondo decor/WebView
y barras legacy; no transporta credenciales ni estado de reproducción. Reaplicar
ante cambio de media query y foreground conserva incluso una paleta explícita
cuando Capacitor restaura su ventana. NativeSettings ofrece Cuenta/Apariencia/
Accesibilidad; Atrás consume primero la sección interna. Haptics/navegación
configurable y restantes ajustes no forman parte de esta aceptación.
