# S2z: Atrás del sistema en la navegación nativa

Implementado y validado después de S2y (8cfd77c); ver HANDOFF y
[evidencia](evidence/s2z.json). El plugin App instalado tiene un callback Android que vuelve por
WebView history cuando no hay listener; las superficies nativas actuales usan
signals y carecen de historial propio. Atrás no resuelve esas vistas.

Registrar un listener App.backButton con ciclo de vida y limpieza. Orden: menú
contextual/modal superior, detalle de biblioteca/podcast, pestaña secundaria,
biblioteca principal y finalmente minimizar app. Nunca parar/limpiar programa o
sesión por navegar. El selector de documentos externo conserva su manejo OS.

Compartir la semántica de cierre del overlay existente (incluido historyBack),
no simular Escape ni buscar botones en DOM. Un modal no descartable consume
Atrás sin navegar por debajo. Los handlers de detalle se registran con cleanup,
se evalúan por orden de montaje y sólo consumen cuando tienen algo que cerrar.
Library: colección → índice de su pestaña; búsqueda activa → búsqueda vacía;
pestaña secundaria → canciones. Las queries de detalle se abortan al volver. Podcasts: show →
directorio. Otras superficies → Library. En raíz App.minimizeApp conserva servicio
multimedia. Eliminar listeners registrados tarde tras unmount y evitar respuestas
antiguas de detalles al volver.

Pruebas: registros/disposal, cierre superior y modal no descartable; APK con
KeyEvent del sistema en colección, menú/editor/letras, podcasts y pestaña; raíz
minimizada y vuelta al primer plano conserva keys/token/posición/pausa y sesión.
Validar HTTP/HTTPS y ausencia de HTML audio. Después repetir regresión principal
completa y continuar biblioteca/Discover/Settings, DJ/Live/Auto y gates de release.


UI1.438/168 y APK2 HTTP/HTTPS sin fallos/omisiones pasan; APK/test/unit/lint
normal pasa después de retirar CA temporal. BackNavigationTest usa KeyEvent del
sistema: colección/pestaña, menú/editor/letras, show/directorio/root, Downloads,
minimizar/volver mantienen keys/token/pausa20s/sesión. Revocar sesión con menú
abierto limpia ventanas/datos privados y programa. No audio HTML.

Fallo real encontrado: OverlayOutlet quitaba DOM al desmontar, pero retenía el
registro y listeners de historia. discardOverlays libera scopes sin history.back;
la cuenta Android lo usa al reset. ContextMenuOutlet también limpia popover.
Modal no descartable consume Back, pero un cambio de cuenta descarta todo.
El helper StartupTest.awaitReady exige estado sin servidor; no se usa para volver
desde minimizar una app conectada. La prueba comprueba su estado conectado real.

Emulador API36; no aceptación de gesto predictivo/fabricantes/hardware físico.
Principal completa y cuatro browser se repetirán por el cambio de limpieza global;
después seguir biblioteca/Discover/Settings y paridad DJ/Live/Auto, firma/release.

La primera regresión completa Chromium dio 277 tests correctos, 66 omitidos y
un timeout en Session DJ móvil inglés: después de seleccionar Route, un settle
de scroll antiguo podía volver a Stage y dejar Route inert. La reparación
anterior de cancelar el RAF al aceptar un gesto ya estaba presente. El conflicto
restante es el settle de 80 ms antes de que corra el nuevo RAF de alineación.
PlayerWorkspace conserva ahora el destino solicitado hasta alcanzarlo; un gesto
real cancela ese destino y sigue teniendo prioridad. Dos pruebas controlan RAF
y timers para cubrir ambas prioridades. UI completa: 1.440 tests/169 archivos.
La prueba nueva contra el código anterior falla (Route vuelve a Stage); la otra
prueba mantiene el gesto correcto. Log /tmp/soundsible-carousel-before.log.
Cuatro perfiles completos pasan: Chromium 278/66 y WebKit 269/75 (pasados/omitidos),
sin fallos. WebKit con un worker, montaje read-only y después de Chromium.
Commit de la reparación: 78669b6; evidencia en s2z.json. Principal Android en
curso sobre assets de 502947d limpio; no contar la reproducción aislada de
Session como sustituto de esas regresiones. Continuar con SLICE_2AA.md.

La primera principal completa sobre 502947d encontró un fallo real en
AutoplayTest.tlsAutoplay, línea de stop: Radio cambia el token al añadir runway
entre state() y command(). El cierre global no edita una ocurrencia ni un orden;
debe conservar UID/generación, como pause, sin que un refill pueda impedirlo.
Corrección preparada en PlaybackService y prueba HTTP/HTTPS reforzada con token
anterior a cambiar autoplay por Radio; una generación antigua debe rechazarse y
conservar el programa. Corrección validada: dos tests HTTP/HTTPS sin fallos ni
omisiones y APK/test/unit/lint normal tras retirar CA temporal; log
/tmp/soundsible-s2z-stop-targeted.log. Pendiente repetir principal completa.
Las ediciones por índice/key conservan su guard de token; no relajar esos tests.

La segunda principal sobre 5ddc166 da 45 casos, dos fallos en Closure HTTP/HTTPS:
la corrección sólo por generación aceptaba un cierre atrasado de otro programa.
Es una regresión real, no un test obsoleto. Contrato final: programToken UUID
estable durante append/refill/edición y distinto al reemplazar la cola o insertar
sobre una vacía. stop valida ese token más UID/generación; el caller antiguo sin
programToken mantiene guard de queueToken. Closure conserva su rechazo de token
de orden inválido y añade reemplazo real de cola seguido de cierre del programa
anterior con el token de orden nuevo. Autoplay confirma identidad conservada tras
pasar de autoplay a Radio/refill y acepta el cierre con el orden anterior.

Los cuatro casos Closure/Autoplay HTTP/HTTPS pasan sin fallos/omisiones, y
APK/test/unit/lint normal sin CA temporal pasa. Log
/tmp/soundsible-s2z-program-identity-native.log. UI completa del working tree
incluye S2aa en curso: 1.462 tests/172 archivos; repetir principal completa tras
commits limpios y cerrar S2aa end to end. Los XML de ejecuciones fallidas están
en integration-failed; integration-results todavía conserva el último éxito.


Regresión compartida durante S2ad: WebKit principal268/75 y un fallo de contexto.
Diagnóstico repetido2 fallos/1 verde muestra contexto presente pero queue inert:
`raw scroll` del helper compite con alineación explícita de apertura, sin gesto
que retire ese owner. El caso de abrir contexto ahora usa botón real Cola y
espera que queue salga de inert. Tres repeticiones WebKit móvil pasan en
/tmp/soundsible-s2ad-webkit-context-fixed.log; cuatro perfiles completos se repiten
antes de marcar aceptada la regresión. No cambiar guards del producto para un
scroll sintético.
