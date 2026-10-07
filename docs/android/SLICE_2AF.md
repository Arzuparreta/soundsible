# S2af: Settings restantes y efectos reales

Preparar después de aceptar S2ae, sin etiquetar sus recorridos pendientes como
paridad. Reutilizar SettingsRows y vistas puras; separar dependencias web antes
de importar una sección. El catálogo de ajustes compartido es la referencia,
no la lista corta actual de NativeSettings.

1. Accesibilidad: haptics persistido y feedback físico vía puente nativo,
   respetando preferencia; editor de destinos de navegación compartido conectado
   a rutas Android reales. Nunca presentar un destino que sólo sea un placeholder.
2. Reproducción: autoplay ya cuenta con contrato nativo confirmado; conectar sus
   ajustes sin otro propietario de audio. Leveling y DJ mixing requieren un efecto
   real en el programa nativo, no sólo PUT o switch. Su aceptación se coordina con
   el DSP de S3 y debe cubrir actual/cued/background, sin doble reproducción.
3. Learning/reset: endpoints Core reales, confirmación, respuesta confirmada,
   error recuperable, cuenta/origen cancelables. Diagnostics del motor con estado
   medido/desconocido; no inventar calidad de red Android a partir de esa lectura.
4. Library/admin/devices/services/Subsonic/sharing: inventariar contratos y
   permisos; portar acciones completas, sin imports de stores/audio/session web.
   Roles, permisos cambiantes y respuestas antiguas deben tener pruebas negativas.

Cada bloque debe aportar UI completa, browser4 si extrae vistas web, APK HTTP/TLS
con Core real, tests de persistencia/cambio de cuenta y evidencia de efecto.
No publicar alpha por tener Settings completo: DJ/Live/Auto/firma/update siguen
siendo gates explícitos. Continuar commit/push hacia PR/main/release autorizados.

## Feedback: decisión de plataforma preparada

Usar `View.performHapticFeedback` y constantes Android para feedback táctil de
acciones, sin permiso VIBRATE ni flags que ignoren preferencias del sistema.
La preferencia de Soundsible debe cortar la petición antes del puente; Android
puede rechazar el efecto según hardware/ajustes, lo que no es un error de audio.
Fuente oficial consultada: [API de haptics](https://developer.android.com/develop/ui/views/haptics/haptics-apis)
y [feedback de eventos](https://developer.android.com/develop/ui/views/haptics/haptic-feedback).
El emulador puede probar scope/configuración/peticiones y falta de permiso extra;
no demuestra la sensación física. No importar stores para leer esa preferencia:
lib/haptics.ts ya la lee de almacenamiento y admite una adaptación pequeña.

## Continuación Settings en fuentes

FeedbackPlugin usa performHapticFeedback sin flags ni permiso VIBRATE; main
instala el transporte exclusivo nativo y la preferencia compartida. Play manual,
controles de programa y favourite confirmado solicitan feedback; el cambio de
cuenta no reinicia una preferencia de instalación. FeedbackSettingsTest HTTP/TLS
está en el run dirigido16 de /tmp/soundsible-s2ae-review-links-native.log; todavía
no aceptar hasta resultado final. UI1526/189 pasa antes del bloque Learning.

Después de preparar ese artifact (fuentes Native/assets congeladas), se añadieron
fuentes UI de Learning: controller sin valores editables inventados, PATCH y GET
confirmados, reset DELETE después de confirmación cancelable, respuesta vieja
abortada al cambiar cuenta/desconectar/desmontar, vista compartida y ruta Android.
Cuatro pruebas de controller y Settings/Rows dirigidas10 pasan. Este Learning
NO está dentro de la APK de revisión/feedback: requiere nuevo prepare e integración
Core HTTP/TLS. Falta diagnóstico, autoplay en Settings y el efecto DSP de leveling
/mixing; admin/services/devices/sharing/navegación y los gates globales continúan.

UI completa posterior1532/191 pasa /tmp/soundsible-s2af-learning-diagnostics-full-ui.log.
Diagnóstico extraído a LinkStatusView compartido; Android lee /api/playback/link
al abrir dentro de scope cancelable, sin inventar muestras ni conservar la lectura
de otra cuenta. Dos pruebas prueban respuesta antigua, desconexión y payload
inválido. APK nueva preparada sobre f4cf550 dirty=true; dirigido Settings6 en
/tmp/soundsible-s2af-settings-native.log: Learning2, Feedback2, Appearance2.
Congelar Native/tests/fixtures/assets durante main y build normal. Native Learning
comprueba efecto real de learning off sobre events, Cancel sin DELETE, reset de
señales/eventos del miembro sin borrar propietario, persistencia Activity, 503 con
retry y programa/sesión intactos. No aceptar hasta terminar; después browser4,
commit/push y principal limpia ampliada con restart2 antes de avanzar DSP/S3.

Primer Settings6 falla2 únicamente al esperar un alert local ante503: la conexión
real marca la app offline y el controller descarta su scope antiguo. Ambos casos
pasan antes learning off, Cancel sin DELETE, reset de member con owner intacto y
Activity. Feedback2/Appearance2 pasan. No aceptar ese run fallido. Expectativa
corregida a estado unreachable de Recommendations y Retry general, conservando
las comprobaciones de preferencia/cookie/programa. Repetición6 en
/tmp/soundsible-s2af-settings-recovery-native.log con mismos assets; sólo cambió
la expectativa Native. Mantener congelación hasta normal build/retirada de CA.

Settings6 repetido termina0: /tmp/soundsible-s2af-settings-recovery-native.log,
cero fallos/errores/omisiones. APK normal/test APK/JVM17/lint pasan y CA temporal
retirada. Confirma recovery global503, preferencia off real/persistente, reset
cancelado/confirmado y owner intacto. UI completa1534/192 pasa
/tmp/soundsible-s2af-settings-final-ui.log; incluye vista Autoplay compartida web
y dos pruebas de futura sección Native aún sin conectar ni dentro de esa APK.
Browser4 de extracciones nuevas pendiente. No confundir Settings aceptados con
leveling/mixing/administración/servicios/sharing completos ni con paridad global.

[Preparación S3a](SLICE_3A.md) fija la regla real de loudness, el tap PCM y los
requisitos de salida única. CompositionPlayer se contrastó con documentación y
source del tag usado; reconfigurar composición recrea holders. No asumir que eso
resuelve una ruta DJ editada en marcha ni importar AudioGraph package-private.
No DSP entregado todavía; Settings Autoplay Native se conecta en continuación.

Chromium completo278/66 pasa sin fallos en /tmp/soundsible-s2af-settings-chromium.log,
1worker. WebKit siguiente secuencial readonly/1worker en
/tmp/soundsible-s2af-settings-webkit.log. Entradas web congeladas durante los runs;
Autoplay Native posterior sólo cambia módulos mobile y su instrumentación.
Native Settings Playback ya conectado en fuentes a runtime.execute/autoplay state,
sin otro controlador ni audio. Cuatro UI dirigidos prueban no defaults editables,
receipts reactivos a través de Settings y espera de confirmación. AutoplayTest
HTTP/TLS ampliado conserva menú original, desactiva/activa desde Settings, verifica
refill/retirada real y Activity/programToken; APK dirigida aún pendiente después
de completar browser4 y UI completa. Principal limpia ampliada pendiente73+2.

Browser4 completos aceptados: Chromium278/66 y WebKit269/75, cero fallos, mismo
server cerrado4173, sequential1worker y WebKit readonly. Logs citados arriba;
Vite propio detenido. Extracciones compartidas Haptics/Recommendations/Link/
Autoplay conservan UX web. Cambios de ruta Autoplay Native posteriores aún
requieren su nueva APK; no estaban dentro de Settings6 anterior.

UI completa Autoplay/gain1536/192 pasa en
/tmp/soundsible-s2af-autoplay-gain-full-ui.log. Nuevos assets e4700ed dirty=true
se preparan para dirigido10: Autoplay2/Closure2/Learning2/Feedback2/Appearance2.
Normal build debe ejecutar20 JVM con los tres vectores/regla nativa S3a nuevos.
No preparar ni tocar Native/tests/fixtures/assets durante ese runner; sus cambios
UI/Root están congelados para aceptar el comportamiento exacto de la nueva ruta.

Autoplay10 aceptado: /tmp/soundsible-s2af-autoplay-native.log termina0, cero
fallos/errores/omisiones. Incluye controles previos+Settings con refill/retirada,
Repeat/Radio/background/Activity/programToken, Closure2 y Settings6. APK/test APK/
JVM20/lint normales pasan sin CA temporal. Los tres JVM de ganancia S3a pasan;
no DSP conectado. UI1536/192 y browser4 278/66+269/75 aceptados. Guardar commits,
preparar limpio y principal73+restart2 antes de cambiar runtime/DSP nativo.

Principal limpia ampliada aceptada46a6c3d dirty=false:73/0+restart1/0+offline1/0,
APK normal/test APK/JVM20/lint sin CA pasan. Runner termina0 en
/tmp/soundsible-s2af-main-clean.log. Fuentes Native/tests/fixtures/resources/assets
congelados durante todo el runner; Subsonic UI posterior no incluido.
