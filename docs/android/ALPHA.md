# Soundsible Android alpha

Cliente Android para tu servidor Soundsible: biblioteca, búsqueda/adquisición,
playlists, podcasts, Radio/Autoplay, NORMAL, DJ con mezcla nativa, Live,
Android Auto y copias explícitas de música sin conexión.

## Instalar y actualizar / Install and update

Descarga `Soundsible-Android-alpha.apk` y comprueba `SHA256SUMS`. Android pide
autorizar la instalación desde el navegador o gestor de archivos. Instala sobre
una alpha anterior para conservar tu cuenta, ajustes y copias offline. No
desinstales para actualizar. Soundsible Dev es una app separada: sus datos no
se migran a la aplicación pública. Las actualizaciones son manuales.

Download `Soundsible-Android-alpha.apk` and verify `SHA256SUMS`. Allow installation
from your browser or file manager when Android asks. Install over an earlier
alpha to keep your account, settings and offline copies; do not uninstall first.
Soundsible Dev is a separate app; its data is not migrated. Updates are manual.

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

Internet conecta al servidor; servicios multimedia y wake lock permiten audio
en segundo plano. Un servicio dataSync prepara las copias solicitadas. En Android
13+ se pide permiso de notificaciones al preparar la primera copia: denegarlo
no bloquea las copias. La cámara sólo se solicita para escanear el QR. Live emite
el programa nativo y no usa micrófono. No se solicitan permisos de archivos
generales: las copias se guardan en el espacio privado de la app.

Internet connects to your server. Media services and wake lock support background
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
