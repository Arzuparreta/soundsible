# Distribución Android y requisitos de publicación

## Desarrollo actual

`android-build.yml` sólo produce artifacts debug y evidencia. No crea GitHub
Releases, tags, APK firmada de distribución, actualizador ni una ficha Google
Play. No cambiar esto como efecto secundario de completar conexión o audio.
El package debug `.dev` evita reemplazar una futura instalación pública.

El público puede acceder a artifacts de un repositorio público; su etiqueta de
desarrollo y caducidad no equivalen a privacidad. Las pruebas usan fixtures y
cuentas dedicadas, nunca música, contraseñas ni logs de una instancia personal.
La firma debug no establece una identidad permanente: no garantizar actualización
entre runners que generan claves diferentes. Las actualizaciones públicas deben
comprobarse con una clave permanente.

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
6. Versión procedente de `shared/version.py` y `scripts/version_sync.py`;
   `versionCode` monotónico para el canal público, validado contra el último
   publicado. No reutilizar counters de distintos workflows como si fueran uno.
7. Publicación Android como **pre-release independiente**, con tag/identificador
   generado por tooling y basado en versión/commit. No usar un tag que dispare
   accidentalmente el workflow global `v*`, ni mover `releases/latest` del servidor,
   desktop o iOS. Extender el tooling con tests antes de habilitar este canal.
8. APK firmada, checksum, metadata de build limpio, permisos documentados,
   notas de instalación/actualización y límites verificados. El manifest de
   capacidades requerido y la decisión offline deben ser gates de publicación.

No escribir una versión de producto a mano, ni siquiera para un ejemplo de tag
Android. El nombre de madurez alpha/beta no crea otra versión comercial.

## Beta y estable

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
