# S2l: directorio, seguimiento y adquisición podcast

El directorio usa la búsqueda del motor y abre RSS sin suscribir ni adquirir.
Seguir/dejar de seguir requiere confirmación del servidor y vive en el menú de
tres puntos del programa. Dejar de seguir conserva los archivos adquiridos.

El menú de episodio ofrece adquisición explícita, retry de fallo/interrupción y
cancelación de trabajo. La cola durable del motor es la autoridad. Sus trabajos
completados desaparecen de queue/status: esa desaparición refresca Library, pero
«Downloaded» requiere un Track adquirido confirmado, nunca sólo ausencia de job.
La observación se cancela al desconectar/cambiar cuenta y vuelve al reconectar.

Streaming y archivo adquirido mantienen el progreso de S2k. El join fallback
requiere GUID más feed o RSS reales; dos shows sin feed ID no se pueden unir por
un GUID homónimo. Offline B sigue cubriendo exclusivamente música adquirida.

El fixture sustituye el borde iTunes/RSS/enclosure con audio sintético. Búsqueda,
RSS, roles, tokens, cola persistente, finalizador y archivos/ranges son rutas
reales. El downloader ahora cierra Response upstream también al fallar status,
tipo o lectura. No se modifican SSRF ni cookies hacia proveedores.

Dos pruebas APK (HTTP y HTTPS verificado) recorren búsqueda, stream sin follow,
follow, adquisición que falla con 503, retry, archivo local con resume y unfollow
sin borrado. La prueba Python reproduce la adquisición real y el aislamiento de
cuenta. Ver HANDOFF para resultados finales de regresión.

Carátulas externas, otras acciones de episodios y el resto de la matriz siguen
pendientes. Esto es desarrollo, no alpha. Continuar con Radio NORMAL nativo y
los gates de teléfono, DJ, Live, Auto, firma y actualización antes de PR/release.
