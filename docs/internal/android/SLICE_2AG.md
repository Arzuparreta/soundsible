# S2ag: acceso Subsonic desde Ajustes Android

## Contrato

Reutilizar la presentación de Subsonic del cliente web, con transporte de cuenta
nativo. Mostrar la URL real del motor, nunca el origen localhost del bundle.
El estado debe venir de GET /api/auth/subsonic; no ofrecer defaults accionables
si falla. Generar/reemplazar/revocar requiere receipt y lectura confirmada dentro
del mismo scope de servidor, identidad, ID de cuenta y username.

La contraseña sólo se entrega una vez y permanece en memoria del panel. Salir,
perder conexión, cambiar cuenta o servidor la elimina. No va a preferencias,
cache offline, programa, logs ni diagnóstico. Un reemplazo o revocación pide
confirmación; cancelarlo no muta el servidor. Una confirmación pendiente pierde
validez al cambiar el scope.

Copiar es una acción explícita al portapapeles Android. El puente valida generación
y sesión antes de escribir, marca la contraseña como sensible y no lee el
portapapeles para entregarlo a JavaScript. No usar fallback browser de credenciales.
[Referencia Android](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste):
ClipData.newPlainText y ClipDescription.EXTRA_IS_SENSITIVE ocultan el preview del
contenido sensible del aviso OS.

## Aceptación pendiente

- HTTP y HTTPS contra el motor aislado real: generar, autenticar /rest con form
  POST, reemplazar y demostrar rechazo de credencial vieja, revocar y demostrar
  rechazo posterior; comprobar que la cuenta owner permanece independiente.
- Cancelar confirmación no envía mutación; recrear Activity conserva estado
  configurado pero jamás contraseña; cambiar cuenta no filtra estado/secret.
- Copia real de dirección/password, flag sensible y rechazo de generación antigua.
  No imprimir secretos/cookies en asserts, timeout DOM o logs. Redactar
  [data-subsonic-secret] en el diagnóstico instrumentado.
- Programa, keys, pausa y sesión se conservan. Ningún HTML audio ni dueño adicional.
- Suite UI completa y cuatro perfiles de navegador tras extracción de vista web.
- APK normal/test APK/JVM/lint sin CA temporal después de instrumentación.

## Estado de implementación

Vista pura compartida extraída, controlador cancelable y ruta Android conectados
en fuentes posteriores al prepare limpio46a6c3d. El adapter clipboard JS requiere
el plugin nativo SoundsibleClipboard, ya añadido después de acabar principal73. No atribuir estos
cambios al artifact principal actual. No marcar paridad ni publicar alpha.

Primer dirigido Native2 pasa HTTP/TLS en /tmp/soundsible-s2ag-native.log,
APK normal/test APK/JVM20/lint sin CA pasan. Credenciales reales autentican via
form POST /rest/ping; reemplazo invalida la primera y revoke invalida la segunda,
owner conserva acceso, Activity no revela secreto, flags del clipboard y rechazo
de generación antigua verificados. UI1547/195 pasa /tmp/soundsible-s2ag-full-ui.log.
Ampliación Subsonic + Account4 en curso: primer Subsonic falla al esperar diálogo
porque el helper eligió Sign out de cabecera en vez de la fila de Cuenta. Scope
específico del localizador pendiente al finalizar runner. No aceptar todavía
cambio de cuenta ni atribuir verde al dirigido4 fallido. Browser4 de esta
extracción todavía pendiente. Congelar inputs Native hasta acabar el runner.

Aceptación dirigida ampliada4/0 en /tmp/soundsible-s2ag-account-fixed-native.log:
Subsonic2 HTTP/TLS incluye logout confirmado desde fila de Cuenta y nuevo login
owner; contraseña temporal desaparece y username/estado corresponden a owner,
credenciales de cada cuenta siguen independientes. Account2 regresión pasa.
APK normal/test APK/JVM20/lint sin CA pasan, XML propio integration-targeted.
Runner anterior account4 falló2 sólo por localizador de cabecera; conservado
como diagnóstico. Principal limpia73+restart2 no sobrescrita. Browser4 en curso.

Browser4 final pasa: Chromium278/66 + WebKit269/75, cero fallos,1worker
secuencial y WebKit readonly. Logs /tmp/soundsible-s2ag-{chromium,webkit}.log.
Entrada web congelada durante ambos runs; DSP Native posterior excluido.
