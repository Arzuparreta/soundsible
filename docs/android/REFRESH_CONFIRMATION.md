# Confirmación de refresh Android tras escrituras

El recorrido principal S2s (33 tests, un fallo) encontró un menú abierto con estado
Saved antiguo después de confirmar la escritura en el motor. sync podía quedar
sustituido por otro refresh (eventos/foreground) y devolver antes de observar la
respuesta más reciente; el caller dejaba de estar pending y abría un menú antiguo.

createAccountRefresh coalesce llamadas por epoch, ejecuta el refresh encolado y
mantiene el mismo Promise hasta observarlo. Un epoch anterior no reencola trabajo
ni borra el Promise de una cuenta nueva. syncOnce mantiene guards de identidad,
cancelación, snapshot y 401/403 existentes. No se cambia la intención explícita
capturada al abrir un menú ni se debilitan las assertions del test de Saved.

Dos tests de contrato prueban callers esperando la segunda observación y separación
entre cuentas concurrentes. Typecheck/Vitest completo con S2t en desarrollo pasa:
1.416 tests /163 archivos. Recorridos CatalogSearch HTTP y HTTPS verificado pasan
con la corrección, dentro de la ejecución filtrada `/tmp/soundsible-s2t-native.log`.
Esa ejecución tuvo dos fallos de EntityBookmarks, que usaba la espera de pantalla
unconfigured tras recrear una cuenta autenticada; no fue una pasada global verde.

Repetir principal y restart sobre fuentes finales. El cambio es independiente de
los bookmarks S2t todavía en validación. No representa paridad completa ni alpha.
