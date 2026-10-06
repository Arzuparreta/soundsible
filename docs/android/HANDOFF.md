# Traspaso del port Android

Estado vigente y forma de trabajar. Lo superado está en
[HANDOFF_HISTORY](HANDOFF_HISTORY.md); los resultados de cada bloque, en
[EVIDENCE](EVIDENCE.md). Plan y matriz: [PORT_PLAN](PORT_PLAN.md); publicación:
[RELEASE_GATES](RELEASE_GATES.md).

## Decisiones vigentes

- Rama `feat/android-port-foundation`. Al cerrar la paridad: **PR abierta con los
  checks en verde para revisión manual**. Sin merge, automerge ni release hasta que
  el usuario lo decida.
- Paridad = paridad de **funciones** con la webapp (alpha). Si la web usa un apaño
  por una limitación del navegador, Android lo hace de la mejor forma nativa.
- UI Solid compartida con adaptadores nativos. Las stores web no se importan en
  Android (poseen el audio web): la lógica pura se extrae a `lib/` o `components/`
  compartidos y Android aporta un controlador nativo. iOS es Swift aparte; avisos
  PAL no verificados se mantienen.
- Offline B: copias explícitas de música adquirida, «Disponible sin conexión» en
  menús de tres puntos; sin adquisición implícita ni autoevicción.
- QR de emparejamiento = sesión completa de la cuenta que lo muestra (S2av).
- No hay teléfono físico: AVD/CI no prueban escucha, Bluetooth ni coche. La
  aceptación física es requisito de beta, no de alpha.

## Cómo se trabaja (actualizado 2026-10-06 para ir más rápido sin perder calidad)

1. **Inventario primero, no por descubrimiento.** La lista de huecos de abajo sale
   de comparar qué textos/acciones alcanza la web y no Android
   (`python3 scripts/android_parity_inventory.py`: alcanzabilidad de imports desde
   `main.tsx` frente a `mobile/main.tsx`). Se cierra la lista; no se abren huecos nuevos sin contrastarla.
2. **Bloques por área, no micro-slices.** Varios huecos de la misma pantalla van en
   un solo bloque, con un solo commit, una ejecución nativa y una fila en EVIDENCE.
3. **Pirámide de pruebas.** Lógica y guardas de carrera → Vitest/JVM (rápido). Prueba
   nativa sólo para lo que cruza la frontera nativa o depende del Core real, y
   **sólo HTTP** salvo que el bloque toque transporte (EngineConnection, TLS,
   sockets, WebRTC/relay, streaming/Range). TLS completo se ejecuta en la regresión
   final, que es la que da la garantía.
4. **Regresión dirigida por radio de impacto**: las clases nativas que usan el código
   tocado, en una sola ejecución. Principal completa + browser4 al final, una vez.
5. **Documentación mínima**: una fila en EVIDENCE por bloque (fecha, commit, pruebas,
   resultado, log). `SLICE_*.md` sólo si hay una decisión de diseño que explicar.
   Sin hashes de fuentes ni JSON por bloque: el commit ya fija el estado.
6. Cada bloque validado termina en commit + push. Gradle sólo `:app:*`; nunca
   `npm run build` en `ui_web`.

## Huecos de paridad pendientes (inventario 2026-10-06)

- [x] S2aw Menú de canción: ir a artista/álbum, «No me interesa» con motivo, reproducir en otro dispositivo.
- [x] Podcasts: sección Top/recomendados con suscribir y «No me interesa»; filtro «sólo descargados» en el programa.
- [x] Biblioteca: ordenar (A–Z, recientes, favoritos primero), filtro descargados, álbumes por género/año.
- [x] Cola: peticiones tras la canción actual como en la web, vaciar peticiones; aviso de reanudar sesión de otro dispositivo (traspaso vía Core).
- [x] Búsqueda: descargar del catálogo pasa por la comprobación del motor (`/api/catalog/save`) y pide «Elegir versión» si duda.
- [x] DJ: «Cambiar sesión» desde una colección (la sesión pasa a ser esa única fuente).
- [x] Ajustes: buscador de ajustes (índice web filtrado a lo que Android dibuja).
- [—] Silenciar: no se porta. En Android volumen y silencio son del sistema (teclas, controles); el botón web
      existe porque el navegador no los tiene.
- [?] DJ «Pedir todas» de una colección: **decisión del usuario pendiente**. El servicio nativo sólo admite
      peticiones de una canción y no tiene grupos que se vayan al cambiar de sesión; sin eso repetiría el fallo
      de las 38 favoritas que sobrevivían a los cambios de sesión. Opciones: implementarlo con grupos nativos o
      dejarlo fuera de Android.
- [→] Puente público/App Links: movido a RELEASE_GATES (punto 9). Necesita clave permanente, `assetlinks.json`
      en la raíz `Arzuparreta.github.io` y APK pública; hoy el puente no pasa nada a Android. Las invitaciones
      viven en el dominio de cada servidor (no verificable): su camino es SEND, ya aceptado (S2at).
- [x] Negativos DJ: el fallo persistente de los streams (503 en todos, ambos platos) ya está en `DjNetworkTest`:
      error visible sin cuelgue, misma ocurrencia y recuperación con reintento explícito.
- [x] Negativos Auto: el socket del coche quedaba muerto al agotar reintentos (fallo real, corregido con
      enfriamiento de 30 s como S2aq). Etiquetas del programa activo: `CarDjTest`/`CarEventsTest`.
- [ ] Regresión final: principal nativa completa HTTP+TLS, restart offline/Live, browser4 (AGENTS).
- [ ] PR con una etiqueta de impacto, base `origin/main` verificada.
- [ ] Requiere al usuario, no bloquea la PR: clave de firma permanente y canal de
      publicación (RELEASE_GATES 4–8).

## Comandos

- JDK21 `/home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1`, SDK
  `/home/arsu/.cache/soundsible/android-toolchain/sdk`: exportar `JAVA_HOME`,
  `ANDROID_HOME` y sus `bin` en `PATH` para `prepare` e `integration`.
- AVD `soundsible-api36`: `emulator -avd soundsible-api36 -no-window -no-audio -no-boot-anim -port 5554`.
- `.venv/bin/python scripts/android.py prepare` y después
  `env 'ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class=com.soundsible.android.A,com.soundsible.android.B' .venv/bin/python scripts/android.py integration`
  (zsh no acepta el nombre con puntos sin `env`). El runner levanta los fixtures
  5097/5098/5099 (y el relay Live si hace falta) y al final compila APK normal,
  JVM y lint. Resultados JUnit en `android/app/build/outputs/androidTest-results`.
- UI: `cd ui_web && npm test && npm run typecheck`. Core: `PYTHONPATH=. .venv/bin/pytest -q tests/…`.
- Fixtures desechables: nunca motor ni cuentas reales. Un vaciado real de biblioteca
  en el fixture retiraría audio compartido: no ejecutarlo.
