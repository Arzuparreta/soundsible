# S2t: bookmarks de álbum/artist y refresh confirmado

Primer vertical validado; no es todavía paridad de entidades/Discover completa.

Primer vertical: Save/Remove from saved en menús de álbumes/artistas adquiridos y
cabecera de colección, con identidad library explícita. PUT saved-entities confirma
la colección devuelta y refresca el snapshot de la misma cuenta; no guarda canciones,
no adquiere archivos ni inicia reproducción. Reutiliza identity helpers puros de
web sin importar stores/navegación/audio web. El estado se vacía al cerrar cuenta.

El refresh Android debe coalescer llamadas concurrentes de la misma cuenta y esperar
el refresh encolado antes de liberar el caller; una respuesta antigua nunca cambia
la cuenta nueva. La regresión principal S2s detectó el menú de Saved capturado antes
de terminar el refresh que sustituyó al iniciado por guardar. Corregir y comprobar
el recorrido real CatalogSearch, no eliminar su assertion.

Aceptación: HTTP/HTTPS; guardar/retirar album y artist, persistencia tras recreación
y logout/login, owner no ve bookmarks member, IDs/playlists/Saved-song intactos,
programa vacío y sin audio HTML. Unitarios de intención explícita, nombres iguales
con IDs distintos, doble selección, respuesta pendiente de cuenta anterior y
refresh concurrente. Recorrido APK validado; repetir regresión principal/restart.

Las listas de bookmarks de entidades externas y navegación Discover todavía deben
implementarse; este vertical ofrece acciones sobre entidades adquiridas. No poner
botones de guardado en el shell ni confundir bookmark con copias offline. El resto
de matriz, DJ/Live/Auto y firma/actualización siguen abiertos; no publicar alpha.


## Validación

Typecheck/Vitest **1.416 /163**, Python saved-entities **15** pasan. APK conjunto
**cuatro tests, cero fallos/omitidos**, HTTP/HTTPS verificado de EntityBookmarks y
CatalogSearch en `/tmp/soundsible-s2t-native-confirmed.log`; incluye el fallo de
Saved encontrado por regresión S2s. Normal APK/test/lint sin CA temporal pasa.
[Corrección de refresh](REFRESH_CONFIRMATION.md) subida aparte como `190c5b4`.

Primeros fallos de bookmarks pertenecían al test: awaitReady exige unconfigured
y no sirve tras recrear una cuenta; esperar Library autenticada y boot completado.
Luego textContent incluía el checkmark aria-hidden de selección: se identifica el
label sin exigir que ese adorno desaparezca. Las assertions de persistencia/cuenta
y pertenencia se mantienen. [Evidencia](evidence/s2t.json).

La APK scoped se preparó con HEAD previo dirty. No es build limpio de release.
Última suite completa S2s33 tuvo un fallo CatalogSearch; última completamente verde
S2q31+restart2. Repetir principal/restart con estos avances; browser cuatro perfiles
se repetirán antes del PR acumulado. Sin CI/proveedor vivo/teléfono/coche aceptados.
Continuar hasta paridad completa y después PR/merge/release autorizados.


Regresión final tras aislamiento de presupuesto auth del fixture: **35 principales
y dos fases persistentes offline pasan**, cero fallos/omitidos, desde cf01599 limpio
al preparar assets. Normal APK/test/unit/lint pasa sin CA temporal; helper exit0.
Log `/tmp/soundsible-s2t-main-isolated.log`. Cierra los fallos de las dos principales
anteriores; no borra su evidencia. Selector OS y artwork embebido siguen pendientes,
así como entidades externas/Discover y resto de matriz.
