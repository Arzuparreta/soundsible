# Soundsible para Android: desarrollo del port

**Estado: scaffolding de desarrollo, no alpha ni cliente funcional.** La APK
actual empaqueta una pantalla Solid local sin servidor configurado y comprueba
el puente nativo. No permite aún conectar, navegar la biblioteca o reproducir.
No se ha validado en un teléfono ni en un coche.

El objetivo es la experiencia completa del teléfono: biblioteca, descubrimiento,
adquisición, NORMAL, podcasts, radio, DJ y Live, más Android Auto. No se publicará
una alpha incompleta. Antes de la alpha también hay que decidir si habrá offline;
si se aprueba, habrá que implementarlo y validarlo. No es una decisión tomada.

## Retomar el trabajo

Leer primero [el traspaso](android/HANDOFF.md), después
[arquitectura y contratos](android/ARCHITECTURE.md),
[slices y matriz de paridad](android/PORT_PLAN.md),
[el primer slice funcional](android/SLICE_1.md),
[la decisión offline pendiente](android/OFFLINE_DECISION.md) y
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
