# Navegación y feedback de carga

Pasada sobre las rutas de `ui_web/src/main.tsx`, navegación móvil/escritorio,
componentes de carga y paneles de ajustes. Rama `fix/ui-navigation-feedback`.

## Hallazgos y cambios

- El cierre del drawer y la selección se completan juntos al recibir
  `popstate`: retirarlo antes exponía brevemente la vista anterior antes del
  skeleton. Los cierres sin selección siguen siendo inmediatos. Se conserva
  el historial y una prueba retrasa su resolución para cubrir la regresión.
- Las rutas divididas en módulos usaban `lazy` sin fallback propio. `asyncPage`
  muestra el destino y su título mientras importa el código, comparte imports
  en vuelo y conserva únicamente el módulo, no la página ni datos de cuenta.
  Una respuesta de una página abandonada no vuelve a montarla. Fallos de import
  y de render tienen reintento y dejan disponible la navegación del shell.
- Artistas monta una cuadrícula local completa. Se permite pintar el título y
  skeleton antes del trabajo de montaje mediante dos frames cancelables. No es
  una virtualización ni una reducción demostrada del tiempo total de montaje.
- Álbumes consultaba al servidor sin skeleton propio y convertía errores en
  colecciones vacías. Ahora separa carga, contenido, vacío y fallo con reintento;
  al refrescar conserva la cuadrícula previa con estado ocupado y texto de carga.
- Las fichas de artista/álbum condicionaban las canciones locales a la respuesta
  del perfil externo. Ya pueden mostrarlas sin esa dependencia. Al pasar entre
  entidades no se presenta el perfil anterior mientras llega el nuevo.
- Listas y portada de Podcasts ya no presentan un vacío antes de terminar su
  carga inicial. Descargas distingue petición pendiente, error y cola vacía.
- Episodios de podcast distinguen error de feed vacío y permiten reintentar.
- Reproducción, configuración de Descargas y acceso Subsonic no ofrecen valores
  por defecto editables antes de leer la configuración. Comparten `SettingsLoad`.
  Usuarios y mejoras lossless también muestran carga inicial y error recuperable.
- Se reutilizan skeletons y botones del sistema visual, con mensajes en los
  cuatro idiomas. No se añade una duración mínima de espera. Los skeletons
  existentes respetan movimiento reducido y anuncian carga a lectores de pantalla.

## Mapa de dependencias y cobertura

| Superficie | Dependencia de datos | Feedback |
| --- | --- | --- |
| Menú móvil, sidebar, barra inferior | Cliente; historial al cerrar drawer | Cierre sincronizado con la selección; destino con fallback común si falta el módulo |
| Canciones, Favoritos, detalle de lista | Store de biblioteca sincronizado | `TrackList` ya tenía skeleton; se conserva |
| Artistas de biblioteca | Catálogo sincronizado; montaje local de grid | Skeleton redondo durante primera carga y antes de montar |
| Álbumes de biblioteca | API de álbumes por orden/filtro/revisión | Skeleton inicial, refresco ocupado, fallo con reintento |
| Artista / álbum | Perfil externo y consulta local por ID independientes | Contenido local independiente; skeleton de descubrimiento y reintento |
| Listas | Store sincronizado | Skeleton inicial de tarjetas |
| Búsqueda / descubrimiento | API, nodos y caché | Ya había skeletons por dominio y resultados previos inertes durante búsqueda; se conserva |
| Podcasts | Suscripciones del store, recomendaciones y búsqueda | Skeleton de portada añadido; feedback de búsqueda existente conservado |
| Episodios | API del feed | Skeleton existente y nuevo error con reintento |
| Descargas | API de cola, después eventos | Skeleton inicial, errores recuperables, progreso por descarga conservado |
| Live | Comunidad / conexión de audio | Estados de conexión, recuperación y creación existentes conservados |
| Importación | Restauración del trabajo y proceso de importación | `StatusCard` y progreso existentes conservados |
| Ajustes locales / cuenta | Preferencias y sesión del cliente | Se muestran sin esperar datos de biblioteca |
| Ajustes de servidor / Subsonic | API de configuración | Skeleton antes de controles reales, error y reintento |
| Usuarios / lossless | API de administración / estado | Skeleton inicial y error recuperable |
| Dispositivos / emparejamiento | API y proceso de pairing | Skeletons y estados existentes conservados |
| Reproductor, letras, menús y acciones de colección | Store, audio y peticiones puntuales | Feedback específico existente conservado; no se bloquea el shell por carga de rutas |
| Login / invitación | Sesión / validación de token | Pantalla de arranque y estados de formulario existentes conservados |

## Validación y límites

`cd ui_web && npm test`: typecheck y **1.163 pruebas / 122 archivos** correctos.
`git diff --check` correcto. Las regresiones añadidas
comprueban navegación con un módulo pendiente, abandono y vuelta a una ruta,
reintento de import, cancelación de frames, cierre antes de popstate, catálogo
pendiente, fallo de álbumes, independencia de pistas locales, cambio de entidad,
cola de descargas y carga de ajustes.

No se ejecutó build local ni se modificaron servicios o datos reales. La revisión
es de código y pruebas DOM/router con peticiones controladas: no constituye una
medición de latencia en móvil ni aceptación visual en un dispositivo físico.
Se mantiene la preferencia previa de revisión visual manual, sin navegador
automatizado. Para esa aceptación: menú → Artistas/Álbumes, primera visita a cada
pestaña con red lenta, volver durante una carga y reintentar tras recuperar red.

Las cuadrículas siguen montando todas las tarjetas tras el primer feedback;
una biblioteca enorme puede requerir un trabajo separado de virtualización.
