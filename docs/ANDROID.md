# Soundsible para Android: desarrollo del port

**Estado: cliente de desarrollo con conexión, programa nativo local/preview y cola/transporte Solid asíncronos (S2j); copias offline explícitas validadas (S6a), no alpha.**
La APK conecta a una instancia, inicia sesión como cuenta, conserva la sesión en
Android y navega canciones, álbumes, artistas y playlists con carátulas y eventos.
Comparte la fila visual Solid; no carga el runtime Web Audio. Los archivos de la
biblioteca reproducen con Media3, transporte/seek y shuffle/repeat; la cola permite
seleccionar, mover, quitar y añadir desde la biblioteca sin reconstruir las fuentes; el servicio conserva
el programa al recrear la Activity, también al fallar la conexión, y ofrece
reintento explícito de audio conservando posición/pausa. Usa la sesión multimedia
de Android. Previews guardados también usan el proxy nativo del motor.
Podcasts/radio, UI completa, edición/adquisición y teléfono/coche siguen pendientes.

El objetivo es la experiencia completa del teléfono: biblioteca, descubrimiento,
adquisición, NORMAL, podcasts, radio, DJ y Live, más Android Auto. No se publicará
una alpha incompleta. Offline B está aprobado: copias explícitas de música adquirida,
«Disponible sin conexión» dentro de menús de tres puntos. S6a implementa y valida
este contrato; no sustituye los requisitos de paridad completa.

## Retomar el trabajo

Leer primero [el traspaso](android/HANDOFF.md), después
[arquitectura y contratos](android/ARCHITECTURE.md),
[slices y matriz de paridad](android/PORT_PLAN.md),
[el primer slice funcional](android/SLICE_1.md),
[el programa nativo y continuación S2](android/SLICE_2.md),
[la decisión offline aprobada](android/OFFLINE_DECISION.md),
[el contrato offline S6a](android/SLICE_6.md) y
[distribución y aceptación](android/RELEASE_GATES.md).
Estos documentos y sus referencias al código son suficientes sin acceso al chat.

## Arquitectura

La interfaz sale de `ui_web/`, con una entrada Android pequeña, Capacitor y una
capa nativa Kotlin en `android/`. Los assets viajan dentro de la APK; no se carga
la web del servidor. El motor sigue siendo la instancia Soundsible del usuario:
no se incluye Python ni un servidor en el teléfono.

Compartir Solid permite que los cambios de UI entren en el siguiente build; no
convierte Web Audio en un reproductor Android. El audio de fondo, mezcla nativa,
Android Auto y emisión Live requieren implementación específica.

El cliente iOS actual es SwiftUI/Swift independiente. No comparte las pantallas
Solid y su comportamiento en dispositivo sigue [sin verificar](IOS.md).

## Entorno Linux

- Node 22 o posterior, npm, Python 3.10+, git.
- **JDK 21**. Exportar `JAVA_HOME` y poner su `bin` delante del JDK del sistema.
- Android SDK: command-line tools, platform-tools, plataforma API 36 y
  build-tools 36.0.0. Android Studio es opcional para los comandos de terminal.
- Para emulador: KVM accesible, paquete emulator e imagen
  `system-images;android-36;google_apis;x86_64`.

Instalar las herramientas siguiendo la
[documentación oficial](https://capacitorjs.com/docs/getting-started/environment-setup).
Con el SDK ya instalado, configurar sus rutas reales (no copiar rutas de otra
máquina):

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME=/ruta/al/jdk-21
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' 'emulator' 'system-images;android-36;google_apis;x86_64'
npm ci --prefix ui_web
python scripts/android.py doctor
```

Capacitor core/CLI/Android están fijados conjuntamente; Gradle Wrapper incluye
checksum. El mínimo del proyecto es API 24 y WebView Chrome 120. **Eso es un
mínimo técnico, no evidencia de funcionamiento en Android antiguos.** La matriz
inicial usa API 36; ampliar versiones requiere pruebas, especialmente de WebView.

## Preparar, compilar e instalar

```sh
python scripts/android.py prepare
python scripts/android.py build
python scripts/android.py install --serial emulator-5554
python scripts/android.py smoke --serial emulator-5554
```

`prepare` genera metadata leyendo la versión central, ejecuta Vite con la
configuración Android y sincroniza Capacitor. `build` añade APK debug, APK de
instrumentación y lint. **No ejecutar `npm run build` localmente.**
La salida Android es `android/web-dist/`; el bundle del motor `ui_web/dist/`
no se escribe. Los assets generados y las rutas locales del SDK no se commitean.

La aplicación de desarrollo es `com.soundsible.android.dev`, rotulada
**Soundsible Dev**. La futura aplicación pública será `com.soundsible.android`.
La APK queda en `android/app/build/outputs/apk/debug/app-debug.apk`.
Para abrir el proyecto con Android Studio, importar `android/` después de
`prepare`. Volver a preparar tras cambiar fuentes antes de compilar desde el IDE.

`build-info.json` registra versión, commit, árbol sucio y contador de desarrollo.
Un árbol sucio nunca debe presentarse como un build exacto de un commit.
`SOUNDSIBLE_ANDROID_BUILD_NUMBER` es un contador de builds de desarrollo, no un
número de release. Su valor local por defecto es 1; CI usa su número de ejecución.

## Conectar la APK

Introducir el origen, sin `/player`, path, usuario, contraseña ni query:
`http://10.0.2.2:5005` para el motor del host desde el AVD; una IP privada/DNS LAN
o Tailscale para la red propia; `https://musica.example.org` para acceso remoto.
El puerto depende de la instancia. `localhost` en el teléfono es el propio
Android, no el host. Un hostname HTTP debe resolver sólo a direcciones privadas;
la comprobación se repite al establecer conexión. HTTPS usa la confianza normal
de Android, sin aceptar certificados inválidos ni seguir redirects autenticados.

Se inicia sesión con la cuenta del motor (o automáticamente en una instancia
única sin contraseña). La contraseña sólo se usa para ese login. La cookie de
sesión permanece en Kotlin, cifrada con Keystore; no está en localStorage, URLs,
WebView cookies ni metadata. Los permisos siguen siendo los de esa cuenta.
Cerrar sesión borra el secreto local incluso si el servidor no responde;
**Actualizar** vuelve a cargar la biblioteca y reabre eventos desconectados.
No cambiar HTTP por HTTPS en una URL sin que el servidor ofrezca TLS.


## Emulador y pruebas

```sh
printf 'no\n' | avdmanager create avd --name soundsible-api36 --package 'system-images;android-36;google_apis;x86_64'
"$ANDROID_HOME/emulator/emulator" -avd soundsible-api36 -no-snapshot -no-window -no-audio -gpu swiftshader_indirect
```

En otra terminal, esperar a que termine de arrancar el dispositivo. Para comprobar
que la pantalla y la traducción se cargan desde la APK:

```sh
adb wait-for-device
adb shell svc wifi disable
adb shell svc data disable
python scripts/android.py smoke
```

Para la integración real con tres motores desechables (cuentas, passwordless y HTTPS):

```sh
# Usar el Python que tenga las dependencias del motor, por ejemplo .venv/bin/python.
python -m pip install -r requirements.txt
# Actualizar primero los assets Solid y el APK si han cambiado las fuentes.
python scripts/android.py build
python scripts/android.py integration --serial emulator-5554
```

El helper sólo acepta un emulador, activa su Wi-Fi, exige puertos 5097/5098/5099 libres,
crea directorios temporales nuevos, arranca las rutas reales de Flask/Socket.IO y
cierra los procesos al terminar. Nunca usa el motor personal o sus directorios.
Para TLS genera una CA/clave efímeras, verifica cadena y hostname, instala la
confianza sólo en recursos debug temporales, ejecuta el APK y elimina esos
recursos y las claves. Después recompila la APK normal sin esa CA; release no
recibe excepciones TLS. No se desactiva la verificación de certificados.
Las cuentas sintéticas son `owner`/`member`, contraseña `android-test`.
`smoke` omite los tests que requieren fixture; `integration` ejecuta los cinco.
Los controles `/__fixture/*` y `/api/android-fixture/*` existen sólo en el proceso
`scripts/android_fixture.py`, nunca se registran en el motor de producción.


El test abre la APK real, espera el arranque Solid, comprueba `App.getInfo`, versión,
identidad, commit, ausencia de peticiones API/socket y service worker controlador,
y recarga la traducción española sin conexión. Es evidencia del **shell local**,
no de offline musical. Conservar resultados de instrumentación, lint, captura y
logcat junto con la metadata del build.

Para cambios compartidos del cliente, ejecutar también `cd ui_web && npm test`
y los cuatro perfiles de navegador completos según `AGENTS.md`; Chromium móvil
no sustituye a WebView ni WebKit. No reiniciar ni usar la biblioteca del motor
personal para estos tests.

## GitHub y límites

El workflow **Android development** compila y prueba los cambios relevantes y
permite ejecución manual. Sus artifacts caducan a los 14 días. En un repositorio
público los artifacts pueden ser descargables: son builds de desarrollo, no una
alpha publicada ni un canal de actualización. El workflow sólo tiene lectura,
no usa claves de firma públicas y no publica releases ni tags.

La futura distribución será APK firmada por GitHub Releases; no requiere Google
Play. No habrá actualización silenciosa por el mero hecho de compartir código.
Ver [los requisitos de publicación](android/RELEASE_GATES.md).


## Primer programa nativo (S2a)

Tocar una canción reproducible crea una cola NORMAL con archivos y previews
guardados de esa vista; las entradas sin vídeo resuelto permanecen desactivadas. Play/Pause,
Previous/Next y seek usan MediaController; título/posición/estado proceden del
servicio. La notificación multimedia lleva la misma metadata y controles.
Una fuente fallida permite reintentar con Play; 401 revalida la sesión y vuelve
al login, 403 muestra falta de permiso. Logout/cambio destruyen el programa.

El programa sobrevive a recreación y background de la Activity, pero este corte
no restaura la cola tras muerte del proceso. S2g añade carátulas privadas al programa, cola y sesión/notificación nativa.
S2h permite cerrar el reproductor con ×: vacía el programa y retira la notificación,
sin borrar login; funciona también con el servidor inaccesible.
S6a añade copias explícitas de música adquirida: «Disponible sin conexión» en los
menús de tres puntos de canciones/colecciones. Preparar y retirar copias sólo afecta
al teléfono. Gestión de preparación y espacio, y filtro local, están en el menú de
biblioteca; no hay un segundo botón Descargar en el shell. Antes del vuelo espera
que todas las canciones deseadas figuren listas en gestión. Copias parciales no
cuentan; carátulas offline usan placeholder. Logout elimina las copias del perfil.
Ver [decisión y límites](android/OFFLINE_DECISION.md). No hay mezcla, DJ/Live ni Android Auto. La cola de desarrollo admite hasta 1.000 ocurrencias locales/preview.
S2i usa el proxy del motor para previews guardados, con progreso y retry 429/503
acotado; sus carátulas nativas usan placeholder.
S2j añade búsqueda de canciones y guardado explícito confirmado por el motor,
sin adquirir archivos; reproduce mediante el mismo servicio nativo.
El siguiente trabajo de S2 integra el contrato asíncrono con la UI autenticada
completa y añade adquisición/podcasts/radio. Ver [contrato y pendientes](android/SLICE_2.md).
