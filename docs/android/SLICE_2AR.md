# S2ar — Catálogo diferido en el programa nativo

NORMAL conserva referencias pendientes en la cola, incluidos duplicados y contexto
de álbum. El loader Media3 consulta el matcher Core cuando abre esa ocurrencia,
valida cuenta/generation/KEY y publica la identidad de preview sin reemplazar la
ocurrencia ni su source vivo. Cache acotada a identidades del programa; reset
cancela requests y resultados tardíos. La UI de colecciones resuelve sólo la
seleccionada inicialmente y conserva el resto para el servicio.

DeviceCatalogSession2 + CollectionProfile4 + CatalogSearch2: HTTP/TLS8/0,
95.019s. Runner exit0, APK/test APK/JVM56/lint normales sin CA temporal.
WholeUI210/1616 + TypeScript pasan. Ver evidence/s2ar.json y
`/tmp/soundsible-deferred-native.log`. Reinicio previo eliminó logs temporales
antiguos; este bloque se ejecutó de nuevo desde el HDD.

No paridad final: siguiente bloque debe aceptar continuación ante matcher404 y
reintentos temporales. DJ rechaza pendientes antes de mutar workspace; no afirmar
resolución DJ diferida. No aceptación física ni suites finales completas.
