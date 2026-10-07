# S2av — Iniciar sesión escaneando un código de emparejamiento

Decisión del usuario (2026-10-06): en Android el QR de emparejamiento inicia una
sesión completa de la cuenta que lo muestra, no el token restringido
(`library:read` + `playback:control`) que usa iOS.

Core: `POST /api/pairing/sessions/claim` acepta `credential: "session"`. Sólo con
la hoja abierta (auto_confirm + display_active) reclama el código, crea una sesión
ordinaria de esa cuenta (cookie HttpOnly, scopes de su rol, nombre y tipo del
dispositivo) y la vincula al registro de emparejamiento; aparece en Dispositivos
emparejados y se revoca desde ahí. Código oculto → 409 `pairing_display_required`
sin consumirlo. Sesiones normales no son revocables por esa ruta. Core pairing7 +
auth/multiuser/subsonic78/0.

Android: botón «Escanear código» abre `PairingScanActivity` (CameraX + ZXing core,
sin Google Play services; permiso de cámara sólo al pulsar). Devuelve únicamente
texto con formato `soundsible_pairing`; la WebView valida origen (http/https sin
credenciales, query ni fragment, rutas exactas, claim/player coherentes) y código
(alfabeto del motor). Alternativa: código escrito con la dirección del servidor.
Cámara denegada/no disponible abre la entrada manual. El nombre del dispositivo
(`DeviceName`, compartido con S2au) nombra también las sesiones de login normales,
antes fijas «Soundsible Android».

QR: el motor sólo sugiere su IP LAN (o nada en loopback). La hoja de Ajustes →
Dispositivos ahora usa la dirección desde la que se ve (web) o el servidor
conectado (Android), y sólo desde loopback recurre a la sugerencia del motor.
Beneficia también a iOS.

PairingTest HTTP/TLS: código oculto rechazado y no consumido; código escrito con
guion/minúsculas inicia sesión como owner con sesión nombrada por el dispositivo;
revocar desde Dispositivos del propio teléfono lo desconecta; cámara denegada
ofrece entrada manual; QR escaneado (resultado de Activity stubbed con
espresso-intents) inicia sesión igual. Scanner real abre CameraX en AVD y Back
devuelve cancelado sin código. Bloque20/0 HTTP/TLS,235.817s + runner exit0 +
APK/test APK/JVM59/lint (lint detectó getMainExecutor API28, corregido).
UI215/1637 + TS. Logs `/tmp/soundsible-pairing-native.log`,
`/tmp/soundsible-pairing-block-native.log`; evidence/s2av.json.
No probado: decodificar un QR real por cámara física (JVM prueba el decoder con
plano de luminancia con stride; el AVD no muestra el QR al sensor).
