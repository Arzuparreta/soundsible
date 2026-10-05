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
