# Distribución Android y requisitos de publicación

## Desarrollo actual

`android-build.yml` sólo produce artifacts debug y evidencia. No crea GitHub
Releases, tags, APK firmada de distribución, actualizador ni una ficha Google
Play. No cambiar esto como efecto secundario de completar conexión o audio.
El package debug `.dev` evita reemplazar la instalación pública.

El público puede acceder a artifacts de un repositorio público; su etiqueta de
desarrollo y caducidad no equivalen a privacidad. Las pruebas usan fixtures y
cuentas dedicadas, nunca música, contraseñas ni logs de una instancia personal.
La firma debug no establece una identidad permanente: no garantizar actualización
entre runners que generan claves diferentes. Las actualizaciones públicas deben
comprobarse con una clave permanente.

## Revisión manual antes de publicación

La entrega de paridad (PR #300) fue revisada e integrada en `main` el
2026-10-07. Ese día el usuario autorizó preparar la distribución, crear una clave
permanente y completar merge/publicación cuando todos los gates estén en verde.
Esta autorización sustituye la espera de revisión manual del 2026-10-05 para
este trabajo de release; no permite saltar checks ni publicar artifacts debug.

Desde el 2026-10-09 la APK sale en la release de cada versión (`v*`), junto a
servidor, escritorio e iOS: `release.yml` llama a `android-release.yml` en el tag,
en el entorno restringido `android-release` (rama `main` y tags `v*`), y adjunta
lo que ese workflow prepara. Ejecutado a mano sobre `main` es un ensayo que no
publica. El tooling `scripts/android_release.py` deriva el `versionCode` de la
versión, valida la APK, exige aceptación de actualización/offline/App Links y
espera a que el CI del commit etiquetado esté en verde antes de entregarla. La referencia
pública de firma es [SIGNING.json](SIGNING.json); capacidades y límites:
[CAPABILITIES.json](CAPABILITIES.json). Instrucciones: [ALPHA](ALPHA.md).

## Estado público (2026-10-07)

La [primera alpha](https://arzuparreta.github.io/soundsible.github.io/es/start/#android-title)
está publicada como prerelease independiente. CI completa y aceptación de su APK
exacta aprobadas; latest global conservado. Instalación y límites: [ALPHA](ALPHA.md).
La aceptación en teléfono, Bluetooth y coche sigue pendiente para beta.

## Primera alpha

Antes de habilitar el workflow de publicación deben cumplirse:

1. Matriz de paridad completa del teléfono, DJ, Live y Android Auto, con pruebas
   de acciones reales y evidencia para cada fila, no sólo pantallas/compilación.
2. [Offline B](OFFLINE_DECISION.md) aprobado por el usuario: copias explícitas de
   música adquirida, «Disponible sin conexión» dentro de menús. Su implementación
   y aceptación deben estar completas; aprobación no equivale a validación.
3. Evidencia funcional automatizada del port completo y límites físicos
   declarados. No confundir contratos/servicio multimedia probados con escucha
   real o aceptación de coche; los gates físicos completos corresponden a beta.
4. Clave de firma permanente con backup, identidad `com.soundsible.android`,
   secrets restringidos al entorno de publicación y SHA-256 del certificado
   documentado. Ningún secreto se usa en PRs de forks ni en builds debug.
5. APK de release instalada y actualización sobre una anterior firmada con la
   misma clave; conservar cuenta/configuración y datos aprobados, sin migración
   destructiva. Probar downgrade rechazado y APK corrupta/firma distinta.
   Desde la segunda alpha, instalar la última APK pública descargada sin
   recompilarla; sólo la primera publicación admite una base sintética. El
   recibo de aceptación registra cuál se utilizó.
   Preparar esa base con su propio `upgrade-seed-androidTest.apk`, conservado
   con checksum en sus assets, y verificar sus SDK contra su metadata original.
   Tras actualizar, sustituir el harness por el del candidato para verificarlo.
6. Versión procedente de `shared/version.py` y `scripts/version_sync.py`;
   `versionCode` monotónico, derivado de la versión y validado contra el último
   publicado.
7. ~~Publicación Android como pre-release independiente.~~ Sustituido el
   2026-10-09 por decisión del usuario: todos los artefactos de una versión salen
   juntos en su release `v*`; la APK conserva «alpha» en el nombre, que basta para
   indicar su madurez. El `versionCode` se deriva de la versión
   (`MMMmmpp99`, `-rc.N` en lugar de `99`), por encima de los códigos que usó el
   canal `android-alpha/*`, cuyas prereleases siguen sirviendo de predecesoras
   para la prueba de actualización.
8. APK firmada, checksum, metadata de build limpio, permisos documentados,
   notas de instalación/actualización y límites verificados. El manifest de
   capacidades requerido y la decisión offline deben ser gates de publicación.

9. Enlaces https a la app (App Links): `assetlinks.json` con el SHA-256 de la clave permanente en
   `https://Arzuparreta.github.io/.well-known/assetlinks.json` (la raíz del dominio, no el subdirectorio del
   sitio), intent-filter `autoVerify` para la ruta `/soundsible.github.io/open/` y, en el puente, un enlace a la
   app sólo cuando exista una APK pública. Las invitaciones usan el dominio de cada servidor y siguen por SEND.

No escribir una versión de producto a mano, ni siquiera para un ejemplo de tag
Android. El nombre de madurez alpha/beta no crea otra versión comercial.

## Beta y estable

La comunidad aporta la aceptación física: el mantenedor no dispone de Android.
La guía y el formato de resultados están en
[ALPHA](ALPHA.md#pruebas-de-la-comunidad--community-testing). Registrar también
los resultados correctos y los casos no probados; no cerrar un gate por ausencia
de reportes de fallos.

La beta requiere aceptación física repetida de escucha, segundo plano, focus,
Bluetooth/controles, Android Auto, redes cambiantes y actualización conservando
perfil. La alpha no promete que todas las combinaciones de fabricante/coche estén
probadas. Para estable, cerrar regresiones del ciclo beta, compatibilidad publicada
y recuperación/diagnóstico. Llevar evidence por dispositivo/OS/WebView, no un
único «Android funciona».

## Actualizaciones y fuentes oficiales

Compartir Solid actualiza el **siguiente build**, no el teléfono instalado.
Primero distribución manual APK; el diseño de aviso/descarga/verificación e
instalación de actualizaciones será un slice separado. Android normalmente pide
consentimiento para instalación externa; no prometer instalación silenciosa.

- [Firma de APK y continuidad de identidad](https://developer.android.com/studio/publish/app-signing)
- [GitHub pre-releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Media3 background playback](https://developer.android.com/media/media3/session/background-playback)
- [Android Auto media](https://developer.android.com/training/cars/media)
- [DHU: requiere dispositivo Android Auto](https://developer.android.com/training/cars/testing/dhu)
- [Dispositivos de laboratorio](https://firebase.google.com/docs/test-lab)

Una granja de teléfonos permite ampliar pruebas, pero no sustituye la escucha en
el coche/Bluetooth del usuario. Coordinar contribuciones de hardware sin afirmar
que CI ha cerrado esas pruebas.
