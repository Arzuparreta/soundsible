# S2af: Settings restantes y efectos reales

Preparar después de aceptar S2ae, sin etiquetar sus recorridos pendientes como
paridad. Reutilizar SettingsRows y vistas puras; separar dependencias web antes
de importar una sección. El catálogo de ajustes compartido es la referencia,
no la lista corta actual de NativeSettings.

1. Accesibilidad: haptics persistido y feedback físico vía puente nativo,
   respetando preferencia; editor de destinos de navegación compartido conectado
   a rutas Android reales. Nunca presentar un destino que sólo sea un placeholder.
2. Reproducción: autoplay ya cuenta con contrato nativo confirmado; conectar sus
   ajustes sin otro propietario de audio. Leveling y DJ mixing requieren un efecto
   real en el programa nativo, no sólo PUT o switch. Su aceptación se coordina con
   el DSP de S3 y debe cubrir actual/cued/background, sin doble reproducción.
3. Learning/reset: endpoints Core reales, confirmación, respuesta confirmada,
   error recuperable, cuenta/origen cancelables. Diagnostics del motor con estado
   medido/desconocido; no inventar calidad de red Android a partir de esa lectura.
4. Library/admin/devices/services/Subsonic/sharing: inventariar contratos y
   permisos; portar acciones completas, sin imports de stores/audio/session web.
   Roles, permisos cambiantes y respuestas antiguas deben tener pruebas negativas.

Cada bloque debe aportar UI completa, browser4 si extrae vistas web, APK HTTP/TLS
con Core real, tests de persistencia/cambio de cuenta y evidencia de efecto.
No publicar alpha por tener Settings completo: DJ/Live/Auto/firma/update siguen
siendo gates explícitos. Continuar commit/push hacia PR/main/release autorizados.

## Feedback: decisión de plataforma preparada

Usar `View.performHapticFeedback` y constantes Android para feedback táctil de
acciones, sin permiso VIBRATE ni flags que ignoren preferencias del sistema.
La preferencia de Soundsible debe cortar la petición antes del puente; Android
puede rechazar el efecto según hardware/ajustes, lo que no es un error de audio.
Fuente oficial consultada: [API de haptics](https://developer.android.com/develop/ui/views/haptics/haptics-apis)
y [feedback de eventos](https://developer.android.com/develop/ui/views/haptics/haptic-feedback).
El emulador puede probar scope/configuración/peticiones y falta de permiso extra;
no demuestra la sensación física. No importar stores para leer esa preferencia:
lib/haptics.ts ya la lee de almacenamiento y admite una adaptación pequeña.
