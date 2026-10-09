# Soundsible para Android: desarrollo del port

**Estado: cliente Android alpha con distribución APK independiente.**
Las descargas públicas sólo aparecen después de aprobar los gates del canal;
la APK alpha va adjunta a cada release de GitHub, junto al resto de plataformas.
La APK conecta a tu servidor Soundsible y usa tu cuenta. Incluye biblioteca,
búsqueda y adquisición, playlists/favoritos/metadatos, podcasts, Radio/Autoplay,
cola NORMAL, DJ con mezcla nativa y Live (escuchar y emitir), además de Android
Auto y copias explícitas sin conexión. La interfaz Solid viaja en la APK; el audio
lo ejecutan los servicios nativos, sin cargar el runtime Web Audio.

La validación automatizada y sus límites están en [EVIDENCE](android/EVIDENCE.md).
El emulador verifica servicios, PCM, transporte y controles; no acredita escucha,
Bluetooth ni funcionamiento en un coche físico. Firma permanente, actualización,
App Links verificados y publicación siguen sujetos a
[RELEASE_GATES](android/RELEASE_GATES.md). El usuario autorizó preparar y publicar la alpha el 2026-10-07 tras cerrar los gates.
La instalación pública y sus límites se describen en [ALPHA](android/ALPHA.md).

## Retomar el trabajo

Leer [HANDOFF](android/HANDOFF.md) para el estado vigente y
[EVIDENCE](android/EVIDENCE.md) para las pruebas. La
[matriz](android/PORT_PLAN.md) conserva la trazabilidad por capacidad; los documentos
`SLICE_*` y el historial describen cortes anteriores, no el estado actual.
La decisión offline vigente es [Offline B](android/OFFLINE_DECISION.md).

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
`smoke` omite los tests que requieren fixture; `integration` ejecuta la suite
principal completa y los protocolos de reinicio offline y Live.
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
permite ejecución manual. La suite instrumentada se reparte en 4 emuladores en paralelo
(`python scripts/android.py integration --shard 0/4`; el shard 0 también ejecuta
el arranque sin red y los protocolos de reinicio) y un job aparte compila, pasa
lint y tests unitarios. Sus artifacts caducan a los 14 días. En un repositorio
público los artifacts pueden ser descargables: son builds de desarrollo, no una
alpha publicada ni un canal de actualización. El workflow sólo tiene lectura,
no usa claves de firma públicas y no publica releases ni tags.

La distribución pública usa la APK firmada adjunta a cada release de GitHub; no requiere Google
Play. No habrá actualización silenciosa por el mero hecho de compartir código.
Ver [los requisitos de publicación](android/RELEASE_GATES.md).


## Uso y revisión de la alpha

1. Para la alpha pública, seguir [ALPHA](android/ALPHA.md) e instalar la APK firmada
   de la release de la versión. La APK debug y su package `.dev` siguen siendo de
   desarrollo y no migran sus datos a la identidad pública.
2. Conectar con dirección y contraseña, o escanear el QR que otra sesión de tu
   cuenta muestra en Ajustes → Dispositivos. También puedes escribir su código.
   El QR inicia una sesión completa de esa cuenta, revocable desde Dispositivos.
3. Reproducir canciones o colecciones. «Añadir a la cola» coloca las peticiones
   tras la canción actual; «Vaciar peticiones» conserva el álbum/playlist y lo
   generado. Puedes reanudar una sesión de otro dispositivo mediante traspaso.
4. Iniciar DJ desde una canción/colección. «Añadir a la sesión» pide la colección
   en grupo; «Cambiar sesión» retira esos grupos y conserva peticiones sueltas.
   Los ajustes de perfil/dirección/fuentes conservan el grupo. La cola admite
   hasta 1.000 ocurrencias; el payload del puente y las respuestas están acotados.
   Si falla la colocación musical, las peticiones quedan en cola y el estado
   muestra el fallback; no se descartan canciones por un fallo del planner.
5. Preparar música adquirida desde «Disponible sin conexión» en su menú. En
   Android 13+ se pide permiso de notificaciones al preparar por primera vez,
   para mostrar el progreso en segundo plano. Denegarlo no impide las copias ni
   la reproducción y no provoca nuevas preguntas. Se puede cambiar después en
   Ajustes de Android → Apps → Soundsible → Notificaciones. No se usa micrófono;
   la cámara sólo se pide al escanear QR.
6. Antes de desconectar la red, comprobar que las copias figuran listas en
   gestión offline. Las parciales no cuentan; las carátulas offline usan
   placeholder. Cerrar sesión elimina las copias del perfil.

Los enlaces recibidos por Compartir (SEND) requieren una acción explícita antes
de cambiar cuenta/servidor. La apertura automática de enlaces https usa la firma permanente y asociación
de dominio verificadas durante la aceptación de cada APK pública. El volumen de escucha
se controla con Android y no cambia el programa que se emite por Live.

## Contribuciones

El trabajo de [emrothenberg en la PR #298](https://github.com/Arzuparreta/soundsible/pull/298)
aportó la propuesta de cliente Android y observaciones incorporadas a este port,
incluido el permiso de notificaciones para las copias offline. Se le acredita
como coautor en el commit de cierre y en la PR. Este cliente conserva el motor
en el servidor del usuario; el servidor embebido de aquella propuesta no forma
parte de esta entrega.
