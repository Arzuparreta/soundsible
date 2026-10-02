# Traspaso del port Android

## Leer antes de continuar

Este archivo es el punto de entrada para otro agente/contributor. No requiere
historial del chat ni memoria privada. Ver [guía](../ANDROID.md),
[arquitectura](ARCHITECTURE.md), [plan y paridad](PORT_PLAN.md),
[primer slice](SLICE_1.md), [offline](OFFLINE_DECISION.md) y
[publicación](RELEASE_GATES.md).

## Decisiones del usuario que siguen vigentes

- APK Android con UI Solid compartida y capa nativa; mantenerla desde el mismo repo.
- Preparación actual: documentación completa y **APK mínima ejecutable**, no
  cliente conectado ni reproductor funcional.
- Objetivo completo: teléfono, DJ, Live y Android Auto. No publicar una alpha
  parcial; los artifacts CI son de desarrollo y pueden ser accesibles públicamente.
- Offline no está decidido. Caso de interés: un vuelo. Preocupan la lógica,
  sincronización y dos botones «Descargar». **Resolver con el usuario antes de
  la alpha; implementar sólo si se aprueba.** No convertir una idea en requisito
  implementado ni decidir por omisión. Ver OFFLINE_DECISION.
- No hay teléfono Android propio. Separar emulador, dispositivos remotos y
  teléfono/coche reales; no llamar a CI aceptación acústica.
- Cada implementación termina con commit en rama, nunca main. Esta preparación
  no autoriza push, PR, merge ni publicación. No delegar sin autorización.
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

No implementado: servidor/cuenta/sockets, reproducción de ningún modo, descargas
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
esa ruta en otras máquinas**. Exportar SDK/JDK como en ANDROID.md. El entorno CI
se ha definido, pero no se ha ejecutado en GitHub sin push.

## Siguiente tarea concreta

Empezar [S1: conexión y biblioteca](SLICE_1.md). Primero demostrar el contrato de
sesión entre motor remoto, cookie jar Android y Socket.IO. `apiOrigin`/cookies
same-origin de la web y `library:read` del pairing iOS no son soluciones completas.
No arrancar stores antes de resolver cuenta ni sustituir autorización por owner.
Cerrar S1 con biblioteca real aislada por cuenta y recuperación, no con mocks
presentados como integración. Después seguir S2→S3→S4/S5; el estudio offline puede
adelantarse, pero necesita una decisión del usuario.

Antes de trabajar: `git status --short --branch`, leer AGENTS y verificar archivos
actuales. Actualizar este traspaso con cada slice: commit, pruebas/evidencias,
capacidad pendiente y próximo paso. No arrastrar resultados antiguos como actuales.
