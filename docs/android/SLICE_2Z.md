# S2z: Atrás del sistema en la navegación nativa

Plan para continuar después de validar y subir S2y. No constituye implementación
ni aceptación. El plugin App instalado tiene un callback Android que vuelve por
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
Library: colección → índice de su pestaña → canciones. Podcasts: show →
directorio. Otras superficies → Library. En raíz App.minimizeApp conserva servicio
multimedia. Eliminar listeners registrados tarde tras unmount y evitar respuestas
antiguas de detalles al volver.

Pruebas: registros/disposal, cierre superior y modal no descartable; APK con
KeyEvent del sistema en colección, menú/editor/letras, podcasts y pestaña; raíz
minimizada y vuelta al primer plano conserva keys/token/posición/pausa y sesión.
Validar HTTP/HTTPS y ausencia de HTML audio. Después repetir regresión principal
completa y continuar biblioteca/Discover/Settings, DJ/Live/Auto y gates de release.
