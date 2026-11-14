# S2ad: Appearance y preferencias visuales compartidas

Compartir las vistas actuales de Appearance y DisplayPreferences mediante props,
sin importar stores de audio en el bundle Android. Mantener etiquetas, orden de
seis temas, idioma, tamaño y contraste. Web conserva sus adaptadores. Android
aplica preferencias locales de instalación también sin motor, con persistencia
que no depende de la cuenta ni cambia programa/copia/sesión.

Usar tabla de temas boot compartida; seguir cambios de sistema y recuperar el
estado tras volver del background. Ajustar documento/theme-color y contraste de
iconos de barras Android, con puente nativo limitado a apariencia y sin acceso a
credenciales. Revalidar estado tras recrear Activity y arranque sin motor. El
selector de idioma debe usar los cuatro diccionarios existentes y actualizar
lang/etiquetas. No ofrecer haptics como validado sólo por navigator.vibrate: su
aceptación y la navegación personalizable se documentarán por separado.

Aceptación: pruebas de almacenamiento inválido/restringido y cambio de sistema,
vista compartida y reactividad; UI completa y cuatro perfiles de navegador.
APK HTTP/HTTPS: tema claro/oscuro/extra/system, idioma, tamaño y contraste,
recreación y offline conservando key/programToken/pausa20s/copia/sesión. Verificar
barras nativas y ausencia de audio HTML. Preparar fuentes limpias y ampliar la
principal; mantener separados los resultados de S2ac y S2ad.

Después completar Playback/recomendaciones, dispositivos/servicios/admin y
Discover, DJ/Live/Auto y firma/update; no equivale a paridad ni a alpha. Continuar
con autorización vigente hasta PR/main/release tras los gates completos.


## Implementación y diagnóstico

AppearanceSettingsView y DisplayPreferencesView comparten la UI con adaptadores
web originales. NativeSettings ofrece Account/Appearance/Accessibility y Atrás
vuelve primero a Account. Preferencias por instalación, tabla boot compartida,
locale común, persistencia restringida tolerada y relectura al volver visible.
UI1489/179 pasa antes del ajuste final de barras; UI completa se repite.

Primer target6: Appearance2 falla tras cambio real de modo OS; Account2 y
Offline2 pasan. SystemBars integrado de Capacitor conserva su propio estilo y lo
reaplica durante configuración, pisando el puente manual. Adaptador ahora usa
SystemBars.setStyle antes del puente limitado a fondo. Segundo target6 confirma
barras/fondo/sistema y falla geometría: nav nueva fuera de class library tenía
botones inferiores44px. Añadida class del shell; target correspondiente pendiente.
Logs /tmp/soundsible-s2ad-{native,system-bars-native}.log. No tratar estos targets
como aceptados ni reemplazar principal53 limpia.

Browser: primer Chromium278/66 pasa; WebKit268/75 falla contexto queue inert por
scroll sintético durante alineación (SLICE_2Z; corrección3cb261f). Segundo
Chromium277/66 detecta popup sin fixture/visibilidad: una pestaña en background
puede mantener primer render pendiente. Test ahora aplica fixture al contexto,
espera boot original, muestra popup y comprueba ficha real antes de teclado.
Cinco repeticiones Chromium pasan /tmp/soundsible-s2ad-popup-visible.log.
Regresión cuatro perfiles completa repetida, no sustituir el resultado fallido
con sólo los casos dirigidos.

Principal55 aad83d4 tuvo54 verdes y fallo OfflineTest TLS al tocar Play tras
recreación. Replay2 con sources/assets originales pasa más normalAPK/testAPK/
JVM17/lint. Helper ahora espera botón realmente habilitado/boot y captura
snapshot/click para diagnosticar; no cambia las comprobaciones de audio offline.
Repetir principal ampliada limpia después de aceptar y guardar S2ad.


## Recorrido Apariencia aceptado

HTTP/HTTPS2 pasa /tmp/soundsible-s2ad-geometry-native.log, sources3cb261f
dirty=true. Seis temas, flips OS reales y modo explícito conservado, iconos nativos
y fondo de ventana, idioma español, tamaño grande/contraste, botones44px y ancho
acotado, recreación y motor503 pasan sin perder key/programa/pausa20s/copia/sesión.
Sin audio HTML. APK/testAPK/JVM17/lint normal sin CA temporal pasa. Account/Offline4
pasaron en el target previo6 con2 fallos de geometría; no llamar verde ese target6.

UI completa1489/179 pasa de nuevo en /tmp/soundsible-s2ad-ui-serial.log. Dos
timeouts de importación fría5s con Chromium/Gradle simultáneos se distinguen del
resultado serial aceptado; no ampliar timeouts del producto ni de los tests.
Header mobile conserva sus comprobaciones geométricas, ahora en un solo frame
y mediante polling: leer dos boundingBox independientes podía capturar un
control sustituido durante resize. Cuatro perfiles completos vuelven a ejecutarse
secuencialmente antes de commit de la capacidad. Principal57+restart2 después.


La medición atómica amplió el diagnóstico a todos los controles y encontró el
título pulsable de AppBar inferior44px, antes no medido entre first/last. Corregido
min-height44px en el componente compartido. Serial previo268/66 con10 fallos no
aceptado:9 títulos pequeños y1 popup mientras el enlace se movía. Ctrl-click ahora
espera settledBox, conserva interacción real y comprobación de nueva ficha.
Dirigido Chromium28/20 sin fallos; repetir suite completa y después WebKit.


## Regresión completa S2ad aceptada

Chromium278/66 y WebKit269/75, cero fallos, los cuatro perfiles completos
secuenciales con1worker como CI. Logs /tmp/soundsible-s2ad-{chromium,webkit}-ci-worker.log.
Popup real mantiene Ctrl-click/foreground, espera DOMContentLoaded y ficha
completa; ocho repeticiones con trace pasan. Con8workers un caso queda esperando
URL incluso tras readiness DOM; no declarar esa ejecución verde. S2ae durante
los runs sólo cambió Native y añadió vistas compartidas aún sin conectar; las
entradas web medidas permanecieron iguales. UI completa con bases S2ae se repite
antes de preparar artifact limpio/principal57+restart2. No paridad ni alpha.


Principal limpia8329de5 dirty=false aceptada:57 más restart prepare1/offline1,
cero fallos/errores/omisiones. APK/testAPK/JVM17/lint normales sin CA pasan.
/tmp/soundsible-s2ad-main-clean.log y evidence/s2ad.json. Posterior UI S2ae en
fuentes no afecta a ese artifact congelado. Continuar hasta paridad y PR/release.
