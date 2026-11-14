# S2ae: Discover y entidades externas

Continuación después de Apariencia. Inventario previo: SearchDiscovery usa
/api/discovery/music/feed, secciones artistas/álbumes y canciones limitadas,
revalidación acotada y feedback. CatalogSearch Android sólo busca track y
library_track; no considerar esa búsqueda Discover completo.

Portar feed y búsqueda all con vistas reutilizables e identidad/cancelación
inyectadas, sin stores de audio web. Fichas Artist/Album usan contratos
ArtistProfile/AlbumProfile y navegación local reversible, incluyendo candidates
ambiguos, álbumes/singles/related y lista de canciones. Preferir extraer las
vistas/transformaciones existentes a duplicar etiquetas y reglas del producto.

Acciones distintas: bookmark de entidad sólo /api/library/saved-entities; guardar
canciones conserva identidad compartida; adquirir canciones y colecciones usa
jobs existentes, muestra cancel/retry/progreso y actualiza snapshot confirmado.
Play/shuffle debe resolver una cola de contexto en transporte nativo, mantener
ocurrencias y prioridad manual. Álbumes homónimos y artista de compilación no se
fusionan por texto. Volver recupera consulta/sección/scroll. Menús siguen siendo
el lugar de Disponible sin conexión para música adquirida.

Aceptar rechazo parcial de proveedor, respuesta pendiente de otra cuenta,
cancel/unmount, colección vacía y recovery; API y preferencias deben quedar
acotadas a origen/cuenta. Tests UI + browser4 para extracciones compartidas;
APK HTTP/HTTPS con contratos Core reales y fixture determinista de proveedor,
sin atribuir esto a proveedores vivos. Aceptación de proveedor real separada.
Regresión principal ampliada sólo después de preparar assets correspondientes;
no cambiar fuentes nativas del artifact que todavía se está verificando.

Settings restantes, DJ, Live, Android Auto y firma/update siguen pendientes.
Mantener gates y autorización de continuar hasta PR/main/release, sin alpha
parcial ni cierre de turno por slice.


## Base implementada, conexión de pantallas pendiente

CatalogSearch delega las acciones existentes a createNativeCatalogActions: mismo
resolve/save/remove/acquire, scope cancelable, identidad confirmada y refresh de
la cuenta que envió la mutación. Las ocho pruebas existentes pasan sin cambiar
su contrato de búsqueda. Todavía filtra canciones; no declarar búsqueda all.

SearchDiscoveryView extrae el layout con navegación/status/song renderer
inyectados, sin stores web. Aún no conectado al adaptador web ni a Android.
createNativeDiscoveryFeed preserva sección explorada y limita revalidación a12
reintentos; aborta y descarta otro perfil incluso si el proveedor ignora abort.
Helpers catalogEntity preservan IDs/Unicode/crédito de compilación; las copias
no implican bookmark ni viceversa. resolveNativeCatalogProgram conserva orden
y ocurrencias, max3 resoluciones simultáneas; selección ausente rechaza en vez
de reproducir otra canción, cancel espera settlement y no publica cola antigua.

Dirigido19/5 pasa en /tmp/soundsible-s2ae-extraction-ui.log. No aceptación Native
S2ae ni feed/fichas end to end todavía. Pendientes conectar vistas, navegación
reversible, artistas/álbumes/candidates, acciones/jobs y fixtures/instrumentación
HTTP/HTTPS. Native57+restart2 de Apariencia sigue pendiente.


Base de fichas: nativeEntitySubject sólo acepta rutas locales de artista/álbum,
conserva provider/local ID y crédito; nativeProfileBookmark usa ID resuelto sin
reemplazar uno explícito. createNativeEntityProfile cancela edición/cuenta/offline
y ofrece retry. ArtistDiscoveryView comparte layout discografía con links/rows
inyectados; aún no conectado al adaptador web ni a Native. Cuatro casos pasan en
/tmp/soundsible-s2ae-profile-view-ui.log. No equivale a recorridos de ficha reales.

## Pantallas conectadas; validación ampliada en curso

Discover comparte SearchDiscoveryView con la web: feed, secciones, artistas y
álbumes, status discreto y canciones. La búsqueda Android incluye explícitamente
track/library_track/artist/album; no se ha implementado todo el catálogo externo
(playlist incluida), por lo que no declarar búsqueda `all` ni paridad completa.
Artist/Album tienen navegación reversible, candidatos, discografía, cola de
contexto nativa y menús de canciones compartidos con Library. Las acciones de
bookmark, guardar canciones, adquisición y copia offline permanecen separadas.
CollectionDownloadView y collectionState se comparten con web, sin sus stores
de reproducción. El controlador Android usa jobs Core confirmados, scope
abortable, revisión/resume y cancel/retry; rechaza otro proveedor/trabajo y
respuestas viejas de polling. La confirmación pendiente se cierra al perder su
cuenta; guardar canciones no adquiere archivos ni marca la entidad.

UI completa:1516/187 pasan (/tmp/soundsible-s2ae-full-ui.log). Seis casos nuevos
cubren recibos incorrectos, cancel de artista, cambio de cuenta al confirmar,
poll tardío, resume ajeno y recuperación de error temporal. La fixture Core
actual valida perfiles/discografía reales contra proveedor sintético: pytest1
pasa (/tmp/soundsible-s2ae-provider-fixture.log). No demuestra proveedor vivo.

En ejecución: Chromium completo; después WebKit completo secuencial. APK
preparada dirty de desarrollo, integración dirigida CollectionProfileTest y
CatalogSearchTest HTTP/TLS en /tmp/soundsible-s2ae-profile-native.log. No aceptar
esos recorridos hasta inspeccionar resultados, ni sustituir aún principal57.
Sigue pendiente adquisición/revisión end to end de colecciones y aceptación
ampliada; Settings/DJ/Live/Auto/firma/update no están completos. Continuar.

Primera integración dirigida:4 fallos; no aceptación. Dos perfiles fallaron por
fixture con ID genérico en lugar de deezer_artist_id/deezer_album_id. Dos casos
CatalogSearch encontraron regresión real: el menú compartido omitía save/remove
al resolver un preview. Fixture corregida y comprobada por pytest1; menú añade
intenciones de catálogo a las acciones compartidas, con scope de consulta/ruta.
Prueba de regresión pasa; dirigido18/2 pasa. UI1516/187 vuelve a pasar antes de
sumar esa prueba. CollectionDownloadView tiene2 casos de decisiones/busy/cancel.
Chromium completo278/66 pasa; WebKit en curso. Nueva integración dirigida en
/tmp/soundsible-s2ae-profile-native-fixed.log; fuentes/assets congeladas durante
su ejecución. No atribuir la primera fallida al producto como validación.

Regresión de adquisición encontrada: el preview cacheado de una resolución no
consultaba su identidad YouTube contra el nuevo snapshot adquirido. Core sí
produjo archivo/álbum/posición reales; Play desde la ficha seguía enviando el
preview. Prueba nueva reproduce el fallo y pasa tras promover por trackKeys,
sin inferir propiedad por título. Holdings de ficha usan ese mismo resolver y
no muestran «0 not found» cuando el trabajo no describe faltantes.
UI completa1520/188 pasa (/tmp/soundsible-s2ae-promotion-full-ui.log).
APK preparada actualizada y6casos HTTP/TLS en curso en
/tmp/soundsible-s2ae-promotion-native.log. Las ejecuciones anteriores de6casos
fallaron; no presentarlas como aceptación. Limpieza de fixture restaura guardados
nuevos incluso si la adquisición añadió una identidad lib, conservando los
existentes. Browser4 final compartido: Chromium278/66, WebKit269/75 pasan;
correcciones posteriores sólo afectan módulos de la entrada Android/tests.
Pendiente adicional: revisión Core end to end y holdings de adquisición sin
resolución previa deben tener aceptación propia, no asumir el camino cacheado.

## Aceptación dirigida de fichas/guardar/adquirir/navegar

Resultado final:6 tests HTTP/TLS pasan,0fallos/errores/omitidos, en
/tmp/soundsible-s2ae-final-directed-native.log. XML dedicado en
android/build/integration-targeted/com.soundsible.android.CollectionProfileTest_com.soundsible.android.CatalogSearchTest/;
no reemplaza integración principal57/restart2. APK normal/testAPK, JVM17 y lint
pasan después de retirar CA temporal. Artifact de desarrollo preparado dirty;
no release ni aceptación acústica.

Cuatro recorridos de colección prueban artista → discografía real → álbum,
play nativo, guardar explícito sin adquirir, adquisición Core/pipeline/archivo
con álbum y posición correctos, conservación de programa durante adquisición,
nueva orden Play sobre fuente local, volver por fichas y consulta/scroll del
contenedor Android. Dos recorridos CatalogSearch prueban save/remove, provider
failure/retry y cuentas después de esos casos. Menús de resultados resueltos
conservan intenciones propias junto con acciones compartidas; holdings usan
identidades confirmadas y caché promovida. Lista sintética larga permite scroll
real; los tests seleccionan controles visibles, no la búsqueda oculta.

UI completa1522/188 pasa; pytest fixture1 pasa. Browser4 compartido pasa278/66 y
269/75. S2ae continúa pendiente de revisión/cancel/retry Core end to end y
adquisición sin resolución previa en APK, además del resto del catálogo externo.
No tratar seis casos dirigidos como matriz completa. Settings siguientes tienen
plan S2AF; adaptador haptic preparado separado, todavía no conectado al APK.

## Revisión Core en curso

CollectionReviewTest añade ocho casos HTTP/TLS: elección de versión con confianza
baja, omisión explícita, cancelación durante resolución y fallo real de adquisición
con reintento. El pytest de fixture recorre Core real hasta needs_review, decision,
resume y archivo adquirido; pasa1 en /tmp/soundsible-s2ae-review-core-fixture.log.
El primer run Native /tmp/soundsible-s2ae-review-native.log NO está aceptado:
encuentra que adquirir sin Save/preview anterior no enlaza el catálogo con el
archivo. Core sólo amplía identidades de canciones ya guardadas. La corrección
UI enlaza identity_keys de filas completed/existing de un job confirmado al
matched_track_id presente en la biblioteca; no crea guardados ni usa títulos.
Prueba dirigida de navegación, retirada y cambio de cuenta incluida. Reintento
esperaba incorrectamente failed a nivel de job; Core usa partial para filas failed.
Corregir esa expectativa y repetir el recorrido antes de aceptar el bloque.
Fuentes Native/fixtures/assets permanecen congeladas hasta terminar este run.

Repetición aceptada: /tmp/soundsible-s2ae-review-links-native.log termina0;
16 tests, cero fallos/errores/omisiones (14 de review/fichas/búsqueda y2 feedback).
XML propio en integration-targeted/com.soundsible.android.CollectionReviewTest_com.soundsible.android.CollectionProfileTest_com.soundsi/.
APK/test APK/JVM17/lint normales pasan y CA temporal retirada. Review elegido,
omitido, cancelado y reintentado recorren Core real HTTP/TLS; adquirir sin guardado
previo termina en Play local. Enlace por identity_keys/matched_track_id confirmado,
retirada de fuente y cambio de cuenta cubiertos en UI. UI1526/189 antes de Learning;
Learning/diagnóstico posteriores se validan por separado y no estaban en esa APK.
El primer run fallido queda diagnóstico, no aceptación. Principal limpia57/restart2
anterior sigue vigente hasta repetir la ampliada desde commit limpio.
