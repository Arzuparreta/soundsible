# Arquitectura y contratos del port Android

## Fuente y alcance

Base inspeccionada para preparar el port:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02. Revisar los símbolos actuales
antes de cada slice: el commit es una referencia histórica, no un pin perpetuo.

Capacitor empaqueta assets locales de Solid y proporciona el puente a Android.
La configuración vive en `ui_web/capacitor.config.json` para resolver dependencias
desde el único package/lockfile del cliente. El proyecto Gradle se conserva en
`android/`; `cap sync` genera sus enlaces a plugins. No introducir otro frontend,
una copia de las pantallas ni un segundo lockfile JavaScript.

## Lo implementado en el scaffolding

- Entrada `ui_web/src/mobile/main.tsx`: preferencias visuales, locale y arranque
  compartidos; no importa sesión, stores, socket, audio o Community.
- `AndroidStart` usa el logo, tokens y diccionarios del cliente. Sin formularios
  que aparenten conectar ni botones de características inexistentes.
- `nativeBuildInfo()` exige Android y consulta el plugin nativo `App.getInfo`.
  Expone plataforma, applicationId, versión y build; un fallo no inventa éxito.
- `vite.android.config.ts` reutiliza el HTML y plugin de arranque web, cambia la
  entrada y base relativa, y excluye publicDir/PWA. La salida está aislada.
- `MainActivity` es una `BridgeActivity` Kotlin. No hay aún servicio multimedia,
  descargas, transporte de cuentas o permisos de cámara/micrófono.
- Android exige TLS para tráfico de red en esta entrega y declara `allowBackup=false`. Las reglas de transferencia y
  almacenamiento de credenciales deben verificarse en S1. HTTP LAN necesita una implementación explícita en el slice de conexión.

Los atributos de metadata en el elemento de montaje existen para probar el
puente. No transportan credenciales ni constituyen un nuevo protocolo servidor.

## Conexión y autenticación: diferencias que no deben ocultarse

| Contrato actual | Fuente y consecuencia para Android |
| --- | --- |
| `apiOrigin()` usa el origen de la página | `ui_web/src/lib/config.ts`; el origen local del paquete no es el motor remoto. |
| REST lleva cookies `same-origin` | `ui_web/src/lib/http.ts`; cambiar sólo la URL no preserva sesión. |
| Sesión de usuario, roles y namespaces | `ui_web/src/lib/session.ts`, `shared/api/routes/auth.py`; no montar stores antes de saber la cuenta. |
| Cookie HttpOnly, SameSite=Lax | Login del servidor; CORS con credenciales por sí solo no resuelve un WebView local. |
| Socket.IO abre contra `apiOrigin()` | `ui_web/src/lib/socket.ts`, `shared/api/__init__.py`; autenticarlo como la misma cuenta que REST. |
| Emparejamiento y scopes | `shared/api/routes/pairing.py`, `shared/hardening.py`; no asumir que `library:read` habilita toda la app. |
| Cliente iOS navega el contrato de coche | `ios/SoundsibleKit/`, `/api/car/*`; no cubre por sí solo descubrimiento, adquisición, edición y Live. |

El primer slice mantiene login de cuenta como contrato del cliente completo. El
transporte nativo debe mantener sesión y recursos autenticados en el contexto de
la instancia seleccionada. Probar cookie jar, Socket.IO y streaming como un único
camino antes de generalizar el adaptador. El emparejamiento es complementario;
no convertir un token limitado en owner/admin ni desactivar autorización para
hacer funcionar la UI. Nunca poner contraseñas o tokens en query strings, logs,
metadata, preferencias web en claro ni URLs compartidas.

Inventariar URL de REST, Socket.IO, cover, preview, podcast stream y audio al
conectar: rutas relativas deben resolver contra el motor; enlaces externos no
reciben su credencial. Preservar cancelación, timeouts, multipart, Range, ETags,
401/403 y aislamiento de cuenta. Tras cambiar servidor/cuenta cancelar trabajos
anteriores y limpiar caches, playback y socket antes de montar el siguiente.

## Audio: un programa, un propietario

Referencia: `ui_web/src/lib/audio/contracts.ts`, `audio.ts`, `audio/transport.ts`,
`audio/graph.ts`, `audio/mixer.ts` y stores NORMAL/DJ. No basta con enganchar Play
al `ExoPlayer` manteniendo el mezclador web activo en paralelo.

El servicio multimedia nativo será dueño de reproducción y estado autoritativo,
incluso con UI suspendida. Solid comparte intención, navegación y planificación;
comandos y eventos del puente reconciliarán snapshots con generaciones para no
aplicar confirmaciones viejas tras cambiar de canción, seek o pausa.

La interfaz `AudioService` actual contiene operaciones síncronas, snapshots y
captura `MediaStream`: un puente asíncrono no puede suplantarla devolviendo éxitos
falsos. Delimitar/adaptar esos contratos con pruebas antes de sustituir el runtime.
Los eventos del sistema deben pasar por el mismo estado que los controles Solid.

[Media3](https://developer.android.com/media/media3/session/background-playback)
aporta sesión, servicio, decodificación y controles, pero no implementa nuestros
EQ, filtros, echo, limiter ni todas las técnicas DJ. Antes del slice DJ, probar
una mezcla real de dos fuentes autenticadas y su captura PCM. Registrar la
solución elegida y su coste; no prometer que dos ExoPlayers equivalen al grafo.
Preservar rutas por `queueId`, recuperación bounded y audio saliente durante
fallos de preparación. El scheduler de transiciones no puede depender de timers
JavaScript cuando la WebView esté suspendida.

## Live y coche

`ui_web/src/lib/community.ts`, `audio/capture.ts` y `docs/LIVE.md` definen que
Live toma el programa **después de mezcla/efectos/limiter y antes del volumen y
mute locales**. El programa nativo necesita ese mismo punto de captura y un
camino probado hacia el relay/WebRTC. Escuchar otra sala no debe reemitirla.
La UI «On air» no es prueba de audio recibido: validar con un listener separado.
Declarar y probar las condiciones de primer/segundo plano, sin atribuir a la web
una continuidad de emisión que hoy no garantiza.

Android Auto requiere `MediaLibraryService`/`MediaSession`, navegación segura del
árbol `/api/car/*` y controles acordes con la cola. No renderizar el workspace DJ
libre en el coche. La existencia del servicio o un emulador AAOS no prueba Android
Auto: [DHU](https://developer.android.com/training/cars/testing/dhu) sigue requiriendo
un teléfono compatible con Android Auto. Registrar ese gate físico por separado.
Una aplicación AAOS instalada en el coche es otro paquete/entrega, fuera del port
móvil inicial; no confundir AAOS con Android Auto.

## Mantenimiento compartido

Un cambio Solid relevante dispara build Android desde las mismas fuentes. Los
adaptadores específicos reciben pruebas de contrato; evitar condicionales de
plataforma dispersos por pantallas. Actualizar conjuntamente core/CLI/Android,
comprobar compatibilidad de plugins, fijar dependencias y mantener Gradle Wrapper
verificado. La versión comercial viene exclusivamente de `shared/version.py`
mediante `scripts/version_sync.py --print`; no copiar una versión en Gradle.
