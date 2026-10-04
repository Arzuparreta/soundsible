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
