# S2y: importación desde export del usuario

S2x cerrado/subido en dc3349d. Continuar sin cerrar turno por slice. Baseline real:
`ui_web/src/routes/Migrate.tsx` (~800 líneas) y `lib/migrationApi.ts`, APIs de jobs
upload/list/get/start/control/decision. Las APIs legacy preview/import-playlist no
cubren selección, progreso, pause/resume/cancel/retry ni revisión de candidatos.

Reutilizar vista completa con adaptador web mínimo (useNavigate), props nativas
para abrir playlists y header compacto. Mantener guía Spotify/Apple, formatos,
selección de biblioteca/playlists, progreso, decisiones y recuperación de jobs.
Inyectar dirección real del motor en Copy station address; window.location de
Capacitor es local y no es una dirección útil para continuar en el ordenador.

Todos los requests de migrationApi admiten AbortSignal opcional. Vista tiene
lifetime/cuenta, guard tras cada await y cancelación de restore/poll/upload al
salir/cambiar cuenta. Poll no acumula requests; una respuesta anterior no adopta
job ni muestra toast en la cuenta nueva. Mantener progreso ante fallo temporal.

Límite real del parser: shared/migration/parsers.py MAX_UPLOAD_BYTES100MiB,
MAX_MEMBER_BYTES25MiB, MAX_ARCHIVE_FILES100. Multipart actual del bridge convierte
File a arrayBuffer/base64 sin límite propio: no usarlo para exports grandes.
Implementar plugin de importación dedicado: selector ACTION_OPEN_DOCUMENT real,
concesión content URI por archivo, RequestBody que lee el stream en chunks al
POST /api/migration/jobs autenticado con generation capturada. No exponer URI a JS,
no permisos amplios, no buffers base64 del archivo completo. JS recibe sólo cancelación o token opaco, nombre, MIME y tamaño. El token se
consume una vez en el transporte multipart habitual para conservar ApiError y
el unauthorized handler existente. URI y bytes nunca cruzan el bridge. El grant
queda ligado a generación, perfil y fingerprint privado de sesión; caduca a los
10 minutos y cada upload tiene límite de 120 segundos.
Consultar metadatos del proveedor fuera del hilo UI, con CancellationSignal,
timeout120s y workers/cola acotados. Aceptar MIME application/* y text/*, porque
el nombre MIME de CSV/plist varía entre proveedores; el parser valida formato y
contenido. Mantener límite100MiB y timeout120s del contrato, cerrar stream/cancelar request
con cuenta/cancel/destroy/timeout; una URI de cuenta anterior no se sube a otra.

Vista ofrece chooser nativo inyectado; web conserva input/drop de File y API
multipart actuales. Back del selector conserva guía/job y no sube. Sembrar CSV
sintético en MediaStore.Downloads, elegir por filename único en DocumentsUI con
tap real (sin simular callback ni URI arbitraria). Probar HTTP/HTTPS contra parser/
matcher/store/service reales, playlist adquirida, controls/review y cuenta privada.
Fixtures usan bytes/proveedor sintéticos, no export ni biblioteca personal.

Verificar formato/size/unknown-size y cierre/cancel del stream con tests nativos
significativos, UI web/nativa completa, contrato API y OS picker end to end. Alpha
requiere después resto de paridad, DJ/Live/Auto y firma/update/release gates.
