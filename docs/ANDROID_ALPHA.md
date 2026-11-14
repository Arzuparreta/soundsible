# Soundsible Android alpha

Cliente Android para tu servidor Soundsible: biblioteca, búsqueda/adquisición,
playlists, podcasts, Radio/Autoplay, NORMAL, DJ con mezcla nativa, Live,
Android Auto y copias explícitas de música sin conexión.

## Instalar y actualizar / Install and update

Descarga `Soundsible-Android-alpha.apk` de la release de la versión y comprueba
`SHA256SUMS-android.txt` (las alphas hasta la 0.21.1 lo llamaban `SHA256SUMS`). Android pide
autorizar la instalación desde el navegador o gestor de archivos. Instala sobre
una alpha anterior para conservar tu cuenta, ajustes y copias offline. No
desinstales para actualizar. Soundsible Dev es una app separada: sus datos no
se migran a la aplicación pública. Las actualizaciones son manuales.

Download `Soundsible-Android-alpha.apk` from the version's release and verify
`SHA256SUMS-android.txt` (alphas up to 0.21.1 called it `SHA256SUMS`). Allow installation
from your browser or file manager when Android asks. Install over an earlier
alpha to keep your account, settings and offline copies; do not uninstall first.
Soundsible Dev is a separate app; its data is not migrated. Updates are manual.

`upgrade-seed-androidTest.apk` es evidencia auxiliar para las pruebas automáticas
de actualización; instala únicamente `Soundsible-Android-alpha.apk`.
`upgrade-seed-androidTest.apk` supports automated upgrade testing; install only
`Soundsible-Android-alpha.apk`.

Conecta con la dirección de tu servidor y tu cuenta, o escanea el QR de
Ajustes → Dispositivos de una sesión existente. El QR inicia una sesión completa
de esa cuenta y puede revocarse desde Dispositivos. Para escuchar sin conexión,
elige «Disponible sin conexión» en el menú de música adquirida y comprueba que
las copias estén listas antes de desconectar. Cerrar sesión elimina esas copias.

Connect to your server using its address and your account, or scan the pairing
QR from Settings → Devices in an existing session. Pairing grants a full account
session, revocable from Devices. Prepare acquired music using “Available offline”
in its menu and check copies are ready before disconnecting. Logout removes them.

## Compatibilidad y límites / Compatibility and limits

Mínimo técnico: Android API 24 y WebView Chrome 120. La evidencia inicial es
en emulador API 36; versiones antiguas no se presentan como verificadas.
Se validan servicios, transporte, PCM, controles, reinicios y actualización.
Escucha física, Bluetooth y coches concretos siguen pendientes para beta.
Los fixtures no prueban todos los proveedores públicos. Se necesita un servidor
Soundsible; no hay un servidor embebido en el teléfono.

Technical minimum: Android API 24 and Chrome WebView 120. Initial automated
evidence uses API 36; older versions have not been verified. Services, transport,
PCM, controls, process restarts and updates are tested. Physical listening,
Bluetooth and individual cars remain beta acceptance work. Fixtures do not
validate all public providers. A Soundsible server is required.

## Permisos / Permissions

Internet conecta al servidor y el estado de red permite detectar la conexión;
servicios multimedia y wake lock permiten audio
en segundo plano. Un servicio dataSync prepara las copias solicitadas. En Android
13+ se pide permiso de notificaciones al preparar la primera copia: denegarlo
no bloquea las copias. La cámara sólo se solicita para escanear el QR. Live emite
el programa nativo y no usa micrófono. No se solicitan permisos de archivos
generales: las copias se guardan en el espacio privado de la app.

Internet connects to your server; network-state access detects connectivity.
Media services and wake lock support background
audio; a dataSync service prepares requested offline copies. Notification permission
is requested for the first preparation on Android 13+; denial does not block
copies. Camera access is requested only for QR pairing. Live publishes the native
programme without microphone access. Copies use private app storage.

Para informar de un fallo, incluye versión/build/commit de `android-release.json`,
modelo, Android y WebView, pasos y si ocurre con red o sin ella. No incluyas
contraseñas, códigos QR, cookies ni música privada.

For a bug report include version/build/commit from `android-release.json`, device,
Android and WebView versions, reproduction steps and online/offline state. Do not
include passwords, pairing codes, cookies or private music.


## Pruebas de la comunidad / Community testing

La aceptación en dispositivos reales corresponde a la comunidad: el mantenedor
no dispone de un Android. Ayuda probando la alpha en tu teléfono y publicando
resultados, incluidos los correctos, en [GitHub Issues](https://github.com/Arzuparreta/soundsible/issues).
Estas pruebas reúnen la evidencia necesaria para beta. Marca como «No probado»
lo que no puedas comprobar; no necesitas disponer de coche ni de todos los accesorios.

Physical-device acceptance comes from the community: the maintainer does not
own an Android device. Test the alpha on your phone and report results, including
successful checks, in [GitHub Issues](https://github.com/Arzuparreta/soundsible/issues).
This provides beta acceptance evidence. Mark unavailable checks as “Not tested”;
a car and every accessory are not required to participate.

| Prueba / Check | Resultado esperado / Expected result |
| --- | --- |
| Escucha NORMAL, DJ y Live / NORMAL, DJ and Live listening | Audio y controles correctos, sin cortes inesperados; Live recibido audible / Correct audio and controls, no unexpected gaps; received Live audio audible |
| Emisión Live desde Android a un oyente remoto / Live publishing from Android to a remote listener | El oyente recibe audio NORMAL y DJ, incluidas transiciones; el volumen local del emisor no altera la emisión / Listener hears NORMAL and DJ audio, including transitions; publisher local volume does not change the broadcast |
| Pantalla apagada y otra app / Screen off and another app | Continúa el programa y funcionan controles multimedia / Programme continues and media controls work |
| Llamada o interrupción de audio / Call or audio interruption | Pausa o reduce según el foco y recupera sin audio duplicado / Pauses or ducks according to focus and recovers without duplicate audio |
| Auriculares y Bluetooth / Headphones and Bluetooth | Controles correctos y desconexión sin reproducción inesperada por altavoz / Correct controls and no unexpected speaker playback on disconnection |
| Wi-Fi, datos y pérdida de red / Wi-Fi, mobile data and network loss | Estado de error visible y recuperación; sin bloqueo / Visible failure state and recovery; no hang |
| Copias listas, modo avión y reinicio / Ready copies, airplane mode and restart | Música preparada audible sin conexión después de reabrir / Prepared music plays offline after reopening |
| Android Auto, si está disponible / Android Auto, if available | Biblioteca, selección, controles y metadata correctos; probar con el coche estacionado / Correct browsing, playback, controls and metadata; test while parked |
| Actualización cuando exista otra alpha / Upgrade when another alpha is available | Instalar encima conserva cuenta, ajustes y copias / Installing over the previous alpha preserves account, settings and copies |

Copia los datos del dispositivo una vez y repite el bloque de prueba para cada
comprobación, incluidas las no probadas. Separa NORMAL, DJ, escucha Live y emisión Live, y los distintos
accesorios o redes si sus resultados difieren. Añade pasos reproducibles para fallos.
Copy device details once and repeat the check block for every check, including
untested ones. Report NORMAL, DJ, Live listening and Live publishing separately, and separate accessories or
networks when results differ. Include reproduction steps for failures.

```text
Build/commit (android-release.json):
Teléfono / Phone:
Android y WebView / Android and WebView:
Servidor Soundsible / Soundsible server build:
Auriculares/Bluetooth/coche usados / Headphones/Bluetooth/car used:

Repetir por prueba / Repeat for each check:
Prueba y modo / Check and mode:
Resultado / Result: OK | Fallo / Failed | No probado / Not tested
Pasos y duración / Steps and duration:
Esperado y observado / Expected and observed:
Red: Wi-Fi / datos / sin conexión — Network: Wi-Fi / mobile data / offline
```

No compartas credenciales, QR de sesión, cookies ni música privada.
Do not share credentials, session QR codes, cookies or private music.
