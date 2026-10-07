# Offline: decisión aprobada

Fecha: 2026-10-03. El usuario elige **incluir B: copias explícitas de música ya
adquirida en el servidor**, con nombre «Disponible sin conexión». Acciones dentro
de menús de tres puntos de canciones/colecciones; ningún botón de preparación en
los shells. La corrección técnica y almacenamiento quedan a criterio de implementación.
El usuario confirma mantener paridad completa antes de alpha; push de avances y
continuar hasta paridad, después PR a main y release. No publicar alpha parcial.

## Contrato de producto

Adquirir música para el servidor y retener una copia en el teléfono son operaciones
distintas. Guardado/bookmark y preview no equivalen a archivo adquirido. Sólo
canciones locales de música son elegibles en este primer offline; no se adquieren
previews implícitamente. Álbum/playlist prepara sus miembros locales actuales; no
sincroniza ni adquiere nuevas incorporaciones automáticamente.

Una biblioteca, con filtro «Sólo en este dispositivo» en su menú. Preparación,
retirada y cancelación viven en los menús de canciones/colecciones. Gestión de
progreso, errores y espacio accesible desde el mismo menú de biblioteca. Preparado
significa archivo completo, longitud comprobada, duración reconocida y checksum;
una copia parcial o fallida nunca cuenta como disponible. Carátulas offline usan
placeholder; se conserva metadata para canciones/álbumes/artistas/playlists.

Copias explícitas sin expulsión automática. Límite inicial 2 GiB, configurable a
512 MiB/2 GiB/8 GiB desde gestión; máximo 1.000 canciones por perfil en este corte.
El límite puede reducirse sin borrar copias: nuevas preparaciones deben caber.
Espacio real del dispositivo mantiene reserva. Cancelar/retirar libera sólo copias
del teléfono, nunca archivos del servidor.

## Antes, durante y después del vuelo

Antes: abrir menú de canción/colección, elegir «Disponible sin conexión» y consultar
gestión hasta que todos los miembros deseados estén listos. Mezclas con previews
preparan únicamente miembros adquiridos. Se muestran número listo/total y fallos.
Durante: app inicia desde assets locales y metadata del perfil verificado; biblioteca
filtra copias listas al no alcanzar el motor. NORMAL/cola/seek/shuffle/repeat usan
el mismo servicio multimedia con archivos privados. No crea servidor autónomo.
Después: revalidar cuenta, refrescar biblioteca y volver a rutas online. No se
envían mutaciones de favoritos/playlists/progreso pendientes: este corte no las
crea. Archivos eliminados del servidor permanecen retirables en el filtro local.

## Cuenta y ciclo de vida

Perfil ligado a origen y cuenta verificada por auth nativo. Logout, cambio de
servidor/cuenta o revocación 401 observada eliminan copias y cancelan preparación.
Sin red no se puede conocer una revocación remota: las copias preparadas siguen
disponibles hasta reconexión o logout local. Activity recreation no corta la
preparación. Descarga explícita mediante servicio foreground dataSync; límite del
SO/interrupción/muerte de proceso deja preparación incompleta recuperable por Retry,
sin declarar disponibilidad ni reanudar red por sorpresa al arrancar.

## Aceptación y publicación

Validar ruta real, preparación UI, persistencia, arranque con motor inaccesible,
reproducción/seek/background, lote/duplicados/cancelación, fallo parcial, espacio,
integridad, aislamiento y logout. Registrar evidencia en HANDOFF al cerrar.
La aprobación offline no sustituye la aceptación de teléfono/DJ/Live/Android Auto.
La paridad se integró mediante PR #300; firma, actualización y publicación se
cierran con RELEASE_GATES. La aceptación física de coche/sonido corresponde a
beta. iOS es referencia de código, no aceptación de dispositivo.
