# Traspaso del port Android

## Leer antes de continuar

Este archivo es el punto de entrada para otro agente/contributor. No requiere
historial del chat ni memoria privada. Ver [guía](../ANDROID.md),
[arquitectura](ARCHITECTURE.md), [plan y paridad](PORT_PLAN.md),
[primer slice](SLICE_1.md), [offline](OFFLINE_DECISION.md) y
[publicación](RELEASE_GATES.md).

## Decisiones del usuario que siguen vigentes

- APK Android con UI Solid compartida y capa nativa; mantenerla desde el mismo repo.
- S0 fue la documentación y APK mínima. El usuario pidió después «push y a por
  el siguiente slice»: S0 se subió y S1 implementa conexión/biblioteca de lectura.
- Objetivo completo: teléfono, DJ, Live y Android Auto. No publicar una alpha
  parcial; los artifacts CI son de desarrollo y pueden ser accesibles públicamente.
- Offline no está decidido. Caso de interés: un vuelo. Preocupan la lógica,
  sincronización y dos botones «Descargar». **Resolver con el usuario antes de
  la alpha; implementar sólo si se aprueba.** No convertir una idea en requisito
  implementado ni decidir por omisión. Ver OFFLINE_DECISION.
- No hay teléfono Android propio. Separar emulador, dispositivos remotos y
  teléfono/coche reales; no llamar a CI aceptación acústica.
- Cada implementación termina con commit en rama, nunca main. Esta preparación
  autorizaba inicialmente sólo commit. La instrucción posterior autoriza push;
  no autoriza PR, merge ni publicación. No delegar sin autorización.
- Respetar AGENTS: versión central, nada de `npm run build` local, suite completa
  de cuatro perfiles cuando se toca `ui_web`, y base remota actual/impact label
  si posteriormente se solicita PR.
- La app iOS es Swift independiente, no Solid sincronizado. Su runtime sigue
  sin validación de dispositivo. Mantener las advertencias sobre iOS/PAL.

## Entrega S0

Rama: `feat/android-port-foundation`. Base inspeccionada:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02.
Para el commit final de S0 usar `git log --oneline --grep='Android port foundation'`;
no confundir el hash base con el commit de esta implementación.

Implementado: documentación y gates; proyecto Kotlin/Capacitor con fuentes y
Wrapper; assets Solid locales separados del bundle del motor; arranque compartido,
locale/preferencias/fuentes; información nativa real; helper prepare/build/install/
smoke; test instrumentado y workflow sin publicación. Los diccionarios Android
incluyen las cuatro lenguas existentes. Ninguna API del motor cambió.

No implementado **en S0**: servidor/cuenta/sockets, reproducción de ningún modo, descargas
locales, DJ, Live, servicio multimedia, Android Auto, firma permanente, actualizador
o publicación. El shell no importa esos runtimes ni solicita sus permisos.

## Validación de S0

Ejecución final local: 2026-10-02. La prueba actual del APK
lleva metadata `dirty=true` por haberse construido en el árbol de implementación;
no es un artifact limpio de un commit de release.

- Typecheck y Vitest: **1.320 tests / 137 archivos pasan**.
- Chromium móvil/desktop completo: **278 pasan / 66 omitidos por condiciones de plataforma**.
- WebKit móvil/desktop completo: **269 pasan / 75 omitidos por condiciones de plataforma**.
- APK debug + APK de tests + lint: **build correcto**, API 36/JDK 21.
- Emulador API 36, puente, arranque y reapertura sin conexión: **1 test instrumentado pasa**, incluida locale española y tema dark tras recrear actividad.
- Ruff check/format y versión central: correctos. Actionlint, diff y enlaces internos: correctos.

Problema encontrado y corregido: ejecutar tareas Gradle sin módulo intentaba
compilar también los tests de bibliotecas Cordova generadas y chocaba con sus
stdlib Kotlin antiguas. El helper apunta a `:app:*`, que prueba y empaqueta nuestra
app con sus dependencias. No se alteraron librerías en node_modules ni se añadió
un override global de Kotlin para taparlo.

[Resumen de evidencia S0](evidence/s0.json) y
[captura de arranque](evidence/startup-api36.png): la captura standalone usa los
defaults English/system-light; el test instrumentado demuestra español/dark.
El fallo inicial de reapertura fue una carrera del test, que consultaba el DOM
antiguo antes de iniciarse la navegación. Recrear la actividad y esperar su nueva
WebView verifica el arranque real.

Resultados reproducibles quedan en `android/app/build/reports/`,
`android/app/build/outputs/androidTest-results/` y artifacts CI futuros. Toolchain
local temporal: `/home/arsu/.cache/soundsible/android-toolchain`; **no depender de
esa ruta en otras máquinas**. Exportar SDK/JDK como en ANDROID.md. El entorno CI de S0
se definió, pero entonces no se había ejecutado en GitHub. El push a una rama
feature no dispara el workflow filtrado a main/dev; no presentar CI como verificado.

## Entrega S1 y evidencia actual

Rama `feat/android-port-foundation`. S0 subido como `3c9ff98`.
Para el commit de S1: `git log --oneline --grep='native account transport'`.

Implementado: origen validado, login de cuenta y passwordless, cookie cifrada en
Keystore, REST/multipart/abort/ETags, carátulas privadas sin cache entre cuentas,
Socket.IO por identidad, logout/cambio/revocación, refresh manual/foreground,
biblioteca de lectura y colecciones usando la fila visual Solid compartida.
No se modifican CORS ni auth del motor; no se importa runtime de reproducción.
HTTP público sigue bloqueado por Android; alias nativo reservado para IP privada,
Host preservado y DNS verificado. Ver decisión técnica en ARCHITECTURE.

Prueba real reproducible: `python scripts/android.py build` y, con Python del
motor y AVD arrancado, `python scripts/android.py integration`. El helper crea
tres motores en directorios nuevos y los apaga. No apuntar fixtures al engine
personal. `android/build/fixture.log` y reportes Gradle conservan evidencia local;
la metadata de las comprobaciones previas al commit dice `dirty=true`.

Resultados finales/evidencia: [S1](evidence/s1.json) y [captura](evidence/library-api36.png).
Typecheck/Vitest: 1.330 tests en 141 archivos; contratos backend: 43 pasan;
APK/lint e integración API 36: 5 tests pasan, incluida WebView con cover real.
Suite browser completa: Chromium 278 pasan/66 omitidos; WebKit 269 pasan/75
omitidos en la repetición final. Una ejecución anterior tuvo un fallo de scroll
en Descubrir; pasó tres veces aislado y después en la suite completa sin cambios
de fuentes. La evidencia conserva ambos resultados.
 No confundir las dos primeras
pruebas fallidas (red del AVD desactivada / lectura de generation como Long) con
el resultado corregido. La política de HTTP privado se comprueba también a nivel
Android: example.com no permite cleartext. El cliente de control del fixture usa
el mismo routing privado pero no adjunta cookie; un OkHttp genérico correctamente
queda bloqueado por la política OS.

HTTPS positivo ya se prueba con motor real y CA efímera/hostname verificado,
además del rechazo de HTTP anunciado como HTTPS. La CA de pruebas se elimina y
el APK normal se reconstruye sin ella. No hay clave privada o confianza de prueba
commiteada. Aceptación de despliegue todavía abierta: instancia HTTPS pública
concreta, DNS LAN/Tailscale reales y teléfono. La biblioteca todavía no ofrece todas las
acciones web ni podcasts/descubrimiento; no marcar paridad completa.


## Siguiente tarea concreta

Seguir [S2: primer programa de audio nativo](SLICE_2.md). Mantener visibles las
aceptaciones S1 pendientes; antes de una entrega pública probar HTTPS remoto y
DNS/Tailscale, además de los gates de paridad. No añadir un segundo propietario
Web Audio ni convertir la biblioteca de lectura en un fork permanente de UI.
Offline sigue sin decisión; no implementarlo en S2.

Antes de trabajar: `git status --short --branch`, leer AGENTS y verificar archivos
actuales. Actualizar este traspaso con cada slice: commit, pruebas/evidencias,
capacidad pendiente y próximo paso. No arrastrar resultados antiguos como actuales.
