# S2: primer programa de audio nativo

## Primer corte vertical

Una canción real de la biblioteca pasa de la fila Solid a un servicio Android
Media3 autenticado: play/pause/seek/fin, metadata/posición y controles de pantalla
bloqueada siguen el mismo estado, incluso con la Activity recreada o en segundo
plano. Una sola fuente/cola NORMAL al comienzo; no DJ, Live, offline ni publicación.
Este corte es la base del S2 completo (podcasts, radio, previews y handoff), no
permiso para una alpha recortada.

## Trabajo concreto

1. Leer `AudioService` y stores actuales. Definir comandos/snapshots asíncronos y
   generaciones antes de montar `AuthenticatedPlayer`. No suplantar operaciones
   síncronas devolviendo éxito de un puente aún pendiente.
2. Añadir MediaLibraryService/MediaSession y una fuente HTTP que usa la cookie
   protegida de EngineConnection. Conservar Range y errores 401/403 sin exponer
   el secreto por JS/URLs ni seguir redirects autenticados. El proxy actual de
   WebView sólo admite covers: no usarlo como transporte de audio.
3. Extraer/adaptar el runtime compartido: biblioteca y filas usan los mismos
   contratos; la variante Android no importa/instancia AudioContext ni HTMLAudio.
   Volver a usar rutas/acciones Solid completas a medida que el runtime exista;
   retirar la superficie de lectura temporal cuando tenga reemplazo probado.
4. Mantener el servicio como dueño del programa, con foco/política de pausa y
   comandos OS. Activity en foreground sólo observa; no publica otro estado ni
   reconstruye una cola al girar/recrear.
5. Logout/cambio cancela audio y recursos antes de otra cuenta; 401 revocado
   para el servicio. Una red caída conserva estado recuperable sin afirmar que
   esté sonando. No activar Web Audio como fallback en Android.

## Pruebas y entrega

Extender el fixture desechable con audio corto propio y respuestas Range reales.
En APK instrumentada: orden y ocurrencias de cola, posición/seek, pausa/fin,
recreación/background, foco, metadata/media controls, 401, servidor caído y
cambio de cuenta en vuelo. Probar el happy path HTTPS válido pendiente de S1.
Separar estado/progreso observado de escucha acústica: emulador no demuestra
Bluetooth, llamadas, Android Auto o coche real.

Ejecutar tests de contratos, build/lint/Android y cuatro perfiles browser tras
cambios UI. Actualizar matriz/evidencia/HANDOFF y cerrar con commit enfocado.
Push autorizado para esta línea de trabajo; PR/merge/publicación no solicitados.
