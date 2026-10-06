# S4l — Programa visible y enlace público de Live

El panel Android muestra título, artista y thumbnail de la pista dominante y
la segunda pista durante una mezcla, con técnica y progreso. Expone también la
pausa del programa y conserva los controles y el chat del servicio nativo.

Sólo admite imágenes del origen HTTPS de Community y del path de la sala actual,
sin usuario/password, query ni fragment. El interceptor nativo reutiliza
LiveArtwork: no cookies/Core headers/redirects, máximo256KiB y dimensiones512.

Compartir abre el selector del sistema con título y enlace al hub público,
construido por el mismo helper que web. No entrega URLs de media ni credenciales.
El plugin admite una sola query session válida en /live/, sin fragment ni query
adicional; conserva el contrato previo de cápsulas de canción y las comprobaciones
de sesión/generación/foco de ventana. Abrir chooser no confirma envío a alguien.

Validación: suite UI completa206/1602 y TypeScript sin errores. LiveUiTest y
ShareTest HTTP/TLS verifican imagen renderizada, chooser interceptado, identidad
pública, rechazo de parámetros extra/duplicados/fragment y regresión de canción.
Inicial4/1 por test TLS pulsando Pause deshabilitado; corregidos waits y slider.
Final LiveUi2/0 (24.451s), runner exit0 + APK/test APK/JVM56/lint normales.
Share2 pasó en inicial y sus fuentes no cambiaron. Ver evidence/s4l.json.
Browser4 se ejecutará antes de abrir la PR final, junto a la regresión conjunta.
No afirma aceptación física ni paridad de las filas restantes de la matriz.
