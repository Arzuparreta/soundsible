# Traspaso del port Android

## Decisiones vigentes

- Rama principal `feat/android-port-foundation`; todos los cambios van por PR.
- Completar teléfono, DJ, Live y Android Auto antes de alpha. Development no es release.
- Validar, commit y push; al cerrar paridad, **PR abierta con checks pasando para
  revisión manual**. **No merge, automerge ni release** antes de revisión/merge del usuario.
- Offline B: copias explícitas de música adquirida, «Disponible sin conexión» en
  menús de tres puntos. No adquisición implícita, preparación en shells o autoevicción.
- UI Solid compartida con adaptadores nativos. iOS es Swift independiente;
  no describirla como port Solid sincronizado. Mantener avisos PAL no verificado.
- No hay teléfono físico del usuario. AVD/PCM/CI no prueban escucha, Bluetooth
  o coche real; aceptación física completa para beta según RELEASE_GATES.
- Seguir trabajando después de cada slice. No delegar sin autorización. No final
  por completar un commit. Suites pesadas seriales; dirigidos durante correcciones.

## Estado y evidencia actuales

Principal: `feat/android-port-foundation`. Paridad completa y PR final todavía pendientes;
consultar git/origin para el HEAD actual.
Ver [PORT_PLAN](PORT_PLAN.md), [RELEASE_GATES](RELEASE_GATES.md) y las evidencias;
[historial](HANDOFF_HISTORY.md) conserva diagnósticos y snapshots anteriores.

- Teléfono: biblioteca/colecciones/bookmarks, NORMAL, podcasts, Radio/Autoplay,
  adquisición/review/importación, metadata/letras, Cuenta/Apariencia/Feedback/
  Learning/Subsonic y offline tienen verticales validados. Menús de canción
  compartidos en ruta/cola; sources y placement DJ desde menús están validados.
- S2ah compartir: native chooser, cápsula pública común o texto local/podcast.
  Share2 + LibraryActions2 + DjContext2,6/0 HTTP/TLS sobre23c5c416 dirty;
  normal APK/test APK/JVM54/lint sin CA. Intent interceptado: no entrega al receptor.
- S2ai recepción: intents VIEW/SEND frío/caliente, antes del login, Play explícito,
  tokens latest-wins y recreate sin replay. Incoming2 + Share2,4/0 HTTP/TLS,
  29.504s sobre9450752c dirty. Fix real: BridgeActivity redespacha intent inicial;
  SharePlugin descarta únicamente el despacho inicial de instancia restaurada.
- S2ai offline: Incoming2/0 HTTP/TLS,19.214s sobref0e02058 dirty; normal APK/test
  APK/JVM54/lint. Copias nuevas conservan youtube_id validado; con APIs503 el
  enlace resuelve copia local. Copias viejas sin identidad requieren prepararse
  de nuevo para matching. Última UI completa204/1595 + TS pasa.
- DJ S3b: Core real, dos decoders estéreo48k/un AudioTrack, técnicas/FX,
  planner/refiner/reparación/placement, source removal, ownership de bridges,
  playback/pausa/background/focus/MediaController y recuperación PCM/red validados
  por bloques. Sources/owned blocks18/0 HTTP/TLS + normal APK/test/JVM54/lint.
  Blocks usa ownership controlado con decoders reales; no todas las combinaciones
  de audio generan bridges en Core. Ver evidence/s3b.json para alcance exacto.
- Ambos inputs PCM:2/0 HTTP/TLS,46.949s sobre450b207d dirty. Ninguna retirada
  sin contraparte sana; al volver outgoing, PCM no silencioso, epoch/reloj retenidos.
  No prueba fallo permanente de ambos streams de red.
- Cola larga servicio/controller:2/0 HTTP/TLS,23.115s sobre6bd23fc4 dirty.
  Core DJ real + append1000; MediaController seek996/6000ms, recorte a4 retiene
  KEY/token/posición/pausa, append a5 y resume PCM. No soak de1000 canciones naturales.
- Última principal verde130/0 sobre d7e95c44 limpio es anterior a los cambios
  anteriores. Restart prepare1/offline1 y normal APK/test/JVM52/lint pasan allí.
- Browser4 último verde anterior a S3: Chromium278/66 skips, WebKit269/75 skips.
  Repetir todos los perfiles antes de PR; nunca sustituir por tests dirigidos.
- Live y firma permanente/update público siguen pendientes. Invitaciones,
  multidispositivo, settings restantes y puente público/App Links siguen pendientes.

## Último bloque integrado y siguiente trabajo

S5a Auto: código trasladado de `/tmp/soundsible-auto-next` sin cambios tras validar.
**12/0 HTTP/TLS,94.079s,runner exit0** en `/tmp/soundsible-auto-search-connection-native.log`.
CarLibrary2 + CarLegacy2 + CatalogSearch2 + TransportReset2 + Connection4.
APK/test APK/JVM54/lint pasan sin CA temporal. Core car/playback11/0.
Ver [S5a](SLICE_5A.md) y [evidence/s5a.json](evidence/s5a.json).

Incluye árbol autenticado, selección canónica, Radio/podcasts, búsqueda sobre
biblioteca adquirida/playFromSearch, copias offline con503 y carátulas otorgadas
por URI opaca.401 limpia copias/programa/grants. SameUID moderno/clásico no prueba
host Google Auto, clasificación trusted externa ni grants a otro UID.

Regresión principal sobredcdd6a3b:144/2,1984.904s,exit1; fallos sólo CatalogSearch
por selector global que abría fila de cola. Normal/restart omitidos por runner.
Corrección c1b8c6b4 confirmada en bloque conjunto; conservar registro fallido en
s3b.json. Principal verde130/0 anterior no equivale a regresión actual verde.

Siguiente S5b: actualización de suscripciones/árbol en background, reconexión y
controles/metadata durante DJ; revisar offline cuando la cookie expira sin401
observado. Corregir guard de root/children frente a generation que cambie entre
capturar epoch y leer identidad (devolver error tipado, nunca excepción del callback).
S5c permite root/copias/search locales con perfil verificado tras expirar cookie;
carpetas Core denegadas y artwork placeholder.8/0 HTTP/TLS,60.403s + normal
APK/test/JVM54/lint sin CA. Ver SLICE_5C y evidence/s5c.json. Carátulas son
cache nativa de proceso; no afirmar covers offline tras muerte de proceso.
Host/DHU y permisos externos siguen pendientes; aceptación física para beta.

S5b validado:8/0 HTTP/TLS,50.108s,exit0 + normal APK/test/JVM54/lint sin CA.
Ver SLICE_5B y evidence/s5b.json. Native socket lazy del car actualiza labels y
playlist counts tras cerrar Activity, conserva KEY/PCM y respeta unsubscribe.
401 concurrente devuelve autenticación expirada a browse pendientes; reset por
desconexión conserva otra razón. Root/children toleran cambio de epoch al leer
identidad. No hay suite activa después de exec21942; AVD5554 sigue disponible.

S5c validado y pushed6c906d2f: cookie expirada sin401 no elimina copias con
backend503; root/search/play locales y logout probados en bloque8/0,60.403s,exit0.
No hay suite activa tras exec24330.

S5d validado: observer de copias locales, bloque8/0 HTTP/TLS101.090s y
completado en background2/0,38.286s; ambos normal APK/test/JVM54/lint sin CA.
Ver SLICE_5D/evidence/s5d.json. No hay suite activa tras exec53504.

S5e validado: CarDjTest2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA;
ver SLICE_5E/evidence/s5e.json. Browsers moderno/clásico conservan programa DJ
al browse/pausa/seek/resume y reflejan canción dominante. Sin suite activa tras49040.

S5f validado: CarEventsTest2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA.
Transport close + handshake503 observado, reconexión recupera etiqueta perdida
con Activity cerrada y conserva NORMAL KEY/PCM. Producción sin cambios; fixture
acelera heartbeat sólo en test. Ver SLICE_5F/evidence/s5f.json. Sin suite activa tras6518.

S5g validado: externo sin trust rechazado y listener autorizado browse/read PNG
por URI opaca, write denegado. CarExternal2 + Legacy2 + Library2,6/0 HTTP/TLS
+ normal APK/test/JVM54/lint; ver SLICE_5G/evidence/s5g.json. Fix producción:
fallback a confianza del sistema API28+ sólo con paquete/UID verificado.
Sin suite activa tras95429.

S5h validado: CarExternal2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA.
Externo playFromMediaId observa ID canónico/playing y PCM; URI reabre antes de
logout y se deniega después. Ver SLICE_5H/evidence/s5h.json. Sin suite activa tras75392.

Prioridad corregida por coste/tiempo del usuario: detener ampliaciones granulares
Auto por ahora y completar Live, el hueco funcional mayor. Luego cerrar pendientes
teléfono/DJ/Auto, firma y regresión final/browser4. Host Google Auto no ejecutado.

S4a validado: LiveInputTest3/0,12.817s (NORMAL Core HTTP/TLS + PCM sintético),
runner exit0 y normal APK/test/JVM54/lint sin CA. WebRTC/Opus real entre peers,
mono16k→stereo48k, mute local conserva emisión, pause=ceros y resume recupera PCM.
Sin AudioRecord ni permiso de micrófono; entrada nativa post-DSP/pre-volumen.
Ver SLICE_4A/evidence/s4a.json. Dependency SHA fijo, recorder Java JNI reemplazado,
resto SDK/binarios intactos y licencias en assets; Python2/0, normal recheck notices.
Siguiente: WHIP/WHEP con relay aislado, luego sala/chat/background/UI. No Live
completo ni paridad. Sin suite activa tras63622/74578. No copiar clone Auto viejo sobre root; fuente vigente es root. Actualizar árbol no prueba labels
actualizadas del programa activo. Luego UID externo, negativos DJ, Live/teléfono/
firma y regresión final/browser4. Clone /tmp/soundsible-auto-next ya se trasladó;
no copiarlo sobre root actual. No aplicar stash/clone viejo. No merge/automerge/release.

## Comandos y reglas operativas

- JDK21: /home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1;
  SDK: /home/arsu/.cache/soundsible/android-toolchain/sdk. Exportar JAVA_HOME,
  ANDROID_HOME y sus bin en PATH **para prepare e integration**.
- `.venv/bin/python scripts/android.py prepare`; integración con android.py
  integration. Dirigidos mediante ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class.
  Gradle sólo :app:*; jamás npm run build en ui_web. UI: npm test + tsc.
- No usar motor/cuentas reales. Fixtures5097/5098/5099; no loguear secretos.
- Antes de PR: suites completas browser4, fetch y ancestry origin/main actual,
  exactly one impact label. Cada implementación validada termina commit/push.
- Clone viejo /tmp/soundsible-android-next tiene sharing ya integrado y network
  viejo en stash; no aplicar ni copiar sobre principal actualizado.
- Investigación Live anterior no implementada: JavaADM AudioRecord no es entrada
  PCM externa; SamplesReadyCallback no inyecta programa. Validar entrada post-DSP/
  pre-volumen sin micrófono y recepción independiente antes de claim de emisión.

S4b relay nativo validado: Core HTTP/TLS crea sesión firmada en Community real;
WHIP HTTPS autenticado → MediaMTX fijado por digest → WHEP HTTPS → PCM nativo.
Mute local, pausa/silencio, resume, Activity cerrada y segundo publisher rechazado
sin perder tap.2/0,runner exit0 + normal APK/test APK/JVM54/lint sin CA.
Ver SLICE_4B/evidence/s4b.json. El runner inicia relay desechable automáticamente
en principal o filtro LiveRelayTest. Siguiente prioridad: socket/lease y metadata
de host desde servicio, adaptador UI y escucha MediaSession. No paridad todavía.

S4c host propiedad de PlaybackService: sesión firmada, WHIP + socket Community,
metadata/heartbeat sin Activity, título y chat; secretos sólo en servicio.
Host2 + Relay2 + Input3,7/0,42.984s,runner exit0 y normal APK/test APK/JVM54/lint
sin CA. Fin explícito borra sala conservando KEY/playback local. Ver SLICE_4C y
evidence/s4c.json. Siguiente: escucha nativa MediaSession y controles UI; después
DJ/metadata/artwork y recovery. No suite activa tras exec30219. AVD5554 sigue.

S4d escucha NativeLivePlayer en MediaSession: Listener2 + Host2 + Relay2 + Input3,
9/0,54.967s,runner exit0 + normal APK/test APK/JVM54/lint sin CA.
PCM independiente vía relay, pausa/volumen/Activity cerrada/stop-prepare/vuelta
a NORMAL; Live recibido no se recaptura para emisión. Fix real: comandos de
selección de música al salir de Live. Ver SLICE_4D/evidence/s4d.json.
Siguiente: controles UI + guest socket/metadata/artwork, después DJ/recovery.
No suite activa tras exec11498. AVD5554 sigue. PR sólo abierta/revisión manual.

S4e UI/guest nativo: directorio por NativeLiveDirectory (WebView bloquea JSON
remoto), host y guest controles/chat reales desde Solid→Capacitor→servicio.
Guest recibe programa/metadata MediaSession/chat/presencia/fin desde socket nativo.
Estado JS sin tokens. Escucha oculta cola/letras/DJ/autoplay como acciones de canción.
Combinado11/0,71.289s antes del probe401; intento final11/2 sólo por marcador
fixture omitido en ambos probesUI (otros9 pasan). Corregido test; UI2/0,20.704s,
runner exit0 + normal APK/test APK/JVM54/lint.205/1599 y TypeScript pasan.
UI prueba emisión/título/chat/fin y directorio/escucha PCM/pausa/volumen/chat/salida,
además401 real→login/biblioteca/panel retirados. Ver SLICE_4E/evidence/s4e.json.
Siguiente Live: DJ/transition metadata + artwork públicos; recovery de media/red/
lease y handshake/reset/proceso. No suite activa tras exec29062. AVD5554 sigue.

S4f validado: Host4/Listener2,6/0,76.723s,runner exit0 + normal APK/test APK/JVM54/lint
sin CA. DJ real al relay con dos pistas/ganancias/progreso de mezcla, NORMAL
publica carátula privada y guest recibe thumbnail público en MediaSession.
Cliente HTTPS separado sin cookies Core, origen/sala/bytes/dimensiones acotados.
Fix cierre TLS sólo en worker; seed DJ determinista desde current. Ver SLICE_4F
y evidence/s4f.json. Log /tmp/soundsible-live-s4f-corrected-native.log. No suite
activa tras58980. AVD5554 sigue. Siguiente: recovery media/red/lease y handshake/
reset/proceso; después regresión conjunta Live. No paridad, merge ni release.

S4g validado: Live combinado14/0,148.745s, runner exit0 + normal APK/test APK/
JVM56/lint sin CA temporal. Host4/Listener2/UI2/Relay2/Input3/Handshake1: cortar
publisher real conserva sala y recupera PCM; cortar listener real conserva pausa,
volumen e identidad. OPTIONS TLS lento10s se cancela desde main en menos3s.
LivePeer.cancel + DELETE2s + Location/media; retries1/2/4s deadline30s; watchdog
lease10s implementado pero agotamiento/lease aún sin aceptación dirigida.
Ver SLICE_4G/evidence/s4g.json, log /tmp/soundsible-live-recovery-native.log.
No suite activa tras13061. AVD5554 sigue. Siguiente: autorización guest antes de
WHEP (hoy Socket y media arrancan en paralelo), lease/polling y process death/
resume409; reset de servicio durante handshake. Luego negativos DJ, teléfono/
Auto/firma y regresión final. No paridad, merge, automerge ni release.

S4h validado: Host4/Listener2 pasan en combinado9/2; TLSUI chat se enviaba
antes de terminar title, y una sala sin limpiar contaminó Polling. Sólo tests
corregidos: UI2/Polling1,3/0, runner exit0 + normal APK/test APK/JVM56/lint.
Producto idéntico entre runs. Ver SLICE_4H/evidence/s4h.json, logs
/tmp/soundsible-live-leases-native.log y /tmp/soundsible-live-leases-ui-fixed-native.log.
Host/guest esperan autorización Socket antes de WHIP/WHEP; rechazo sala con
WHEP real no produce PCM. Lease perdida en background retira Live tras10s,
conservando local; polling-only35s sobre ping20s estable. No suite activa tras
31747. AVD5554 sigue. Siguiente: proceso/resume409 y agotamiento/reset. El
publisher muerto puede seguir ocupando MediaMTX aunque Core rote tokens;
continuidad debe retirar sólo la resource del owner firmado y probarse en relay
real, no basta POST resume. Sources vigentes root. PR no creada aún (ghprview
verificado). No final de checkpoint, no merge/automerge/release.

S4i validado: resume firmado retira publisher real antes de rotar credenciales,
conserva sala/programa y protege DELETE tardío con if_host_token. Native crea o
reanuda409 y continúa seq. Core19/0; LiveResume HTTP/TLS2/0,16.256s;
LiveRestart prepare1/0,5.935s + force-stop + resume1/0,5.277s: PID distinto,
cookie cifrada conservada, misma sala, seq creciente y PCM WHEP independiente.
Ambos runners exit0 + APK/test APK/JVM56/lint normales sin CA temporal.
Logs /tmp/soundsible-live-resume-fixed-native.log y
/tmp/soundsible-live-process-restart-native.log. Ver SLICE_4I/evidence/s4i.json.
No regresión principal/browser completa en este bloque. AVD5554 sigue, ninguna
suite activa. Siguiente: agotamiento/reset/foco Live, después restantes teléfono/
DJ/Auto/firma y regresión final. PR abierta para review manual cuando paridad;
no merge, automerge ni release. Ping Community20s/timeout25s corregido en docs.

S4j aceptación dirigida4/0,56.701s: listener rechazos reales de autorización relay,
cuatro intentos exactos, agotamiento estable, recuperación manual/volumen, foco
transitorio por AudioManager y noisy por UID sistema. Reset de cuenta durante
OPTIONS TLS lento retira receptor <3s; no reintenta en8s ni acepta prepare viejo.
Runner53807 exit0 + APK/test APK/JVM56/lint normales sin CA temporal. Log
/tmp/soundsible-live-recovery-final.log. Ver SLICE_4J. Siguiente: publisher
agotamiento/reset dirigido, presentación/share Live y pendientes de matriz.

S4k validado: publisher HTTP/TLS2/0,85.109s, runner21182 exit0 + APK/test APK/
JVM56/lint normales. Activity cerrada: tres retries reales rechazados, Live
retirado estable conservando música/KEY, Go live recupera misma sala. Segundo
corte + reset cancela retries sin publisher y sin nuevas autorizaciones en5s.
Log /tmp/soundsible-live-publisher-exhaustion.log, SLICE_4K/evidence/s4k.json.
Ninguna suite activa; AVD5554 sigue. Siguiente: presentación del programa y
compartir Live; luego restantes matriz y regresión final. No merge ni release.

S4l validado: programa primary/secondary/artista/thumbnail/mezcla/pausa y share
público común web→chooser nativo. UI206/1602 + TypeScript pasan. Inicial4/1:
HTTPUI/Share2 pasan; TLSUI pulsó Pause deshabilitado durante cambio volumen.
Test espera controles disponibles; slider deshabilitado durante busy. FinalUI2/0,
24.451s, runner36960 exit0 + APK/test APK/JVM56/lint normales sin CA temporal.
Imagen real WebView, chooser interceptado y rechazo query extra/duplicada/fragment.
SLICE_4L/evidence/s4l.json, /tmp/soundsible-live-presentation-fixed-native.log.
Ninguna suite activa, AVD5554 sigue. Siguiente: invites/admin/multidispositivo
según inventario real, negativos DJ/Auto y distribución; principal/browser4 final
aún pendientes. PR abierta review manual, no merge/automerge/release.

S2aj validado: invite pegado explícitamente en conexión, preview/accept nativo,
contraseña confirmada, bind perfil/cookie y biblioteca aislada sin reload.
Native2/0 HTTP/TLS,17.238s, runner28188 exit0 + APK/test APK/JVM56/lint normales.
Inicial2/2 por helper test que esperaba startup sin configurar aunque Core seguía
configurado; corregido inicio fresh/waitlibrary en recreate. WholeUI208/1606
antes de copy hint y guard de mensaje preview pendiente; dirigido final5/0 y
TypeScript pasan. SLICE_2AJ/evidence/s2aj.json, log
/tmp/soundsible-invite-corrected-native.log. Ninguna suite activa, AVD5554 sigue.
Siguiente: admin y controles/handoff entre dispositivos, negativos DJ/Auto,
distribución y regresión final. No OS invite intent probado aún. PR manual;
no merge/automerge/release. Sources vigentes root.

S2ak validado: Settings Personas sólo admin reutiliza panel web con account/current
y guards tras diálogos/respuestas/copiar; cleanup invalida. WholeUI209/1610 +
TypeScript pasan; UsersTest HTTP/TLS2/0,25.67s, runner53270 exit0 + APK/test APK/
JVM56/lint normales. Admin crea cuenta/invite y desactiva confirmado Core; miembro
sin menú ni acceso /api/users403. SLICE_2AK/evidence/s2ak.json, log
/tmp/soundsible-people-native.log. Ninguna suite activa, AVD5554 sigue. Siguiente
multidispositivo: dueño/socket en PlaybackService con playback_register, eventos
playback_*_requested y estado/handoff Core; no activar audio/store web.
ProgramCarSubscriptions sólo al suscribir Auto, no dueño remoto general. Faltan
negativos DJ/Auto, firma/distribución y principal/browser4 final. PR manual.

S2al accepted: NativeDeviceSession owns authenticated Core registration/control
with Activity closed. NORMAL bounded state and real incoming handoff preserve
queue/index/position/shuffle/repeat; remote resume preserves occurrence identities.
Two Core bugs fixed: socket registration binds its account rather than default;
remote pause retains track/position/session, avoiding immediate-play404.
Core14/0; DeviceSession HTTP/TLS2/0,15.639s; integration exit0 and normal APK/test
APK/JVM56/lint without fixture CA. Log /tmp/soundsible-device-session-final-native.log.
See SLICE_2AL and evidence/s2al.json. No UI change in this slice.
Next device-list UI/outgoing handoff, DJ/Radio workspace and pending catalog
restoration; then remaining pairing/public links, DJ/Auto negatives, distribution
and final principal/browser4. Do not claim full multidispositivo parity yet.
Never merge/automerge/release; final PR stays open for manual review.

S2am accepted: Settings Devices reads native service identity, lists account-scoped
Core devices and sends controls through authenticated native HTTP. UI210/1613+TS;
DevicesUi + DeviceSession4/0 HTTP/TLS,31.097s, runner exit0 + normal APK/test
APK/JVM56/lint. Core15/0; /api/devices now exposes socket_active from active_sid
for shared web/native UI. Earlier UI test failure was API contract mismatch,
not registration overwriting SID; latter was an incorrect intermediate diagnosis.
See SLICE_2AM/evidence/s2am.json. Next outgoing handoff must publish exact fresh
native state then call Core handoff with same-account/generation checks. Full DJ/
Radio/pending catalog restore, public invite intents/pairing, negative coverage,
distribution and final full suites remain. Continue; PR manual, no release/merge.

S2an accepted: Settings transfer delegates to native actor, verifies same-account
online peer, publishes fresh bounded NORMAL queue/position then calls Core handoff.
Queue/preferences/transport/identity changes cancel pre-send, reset cancels future/
request, no optimistic source pause. Real UI to remote Core socket + source pause
HTTP/TLS, combined DevicesUi/DeviceSession4/0,31.965s; normal APK/test/JVM56/lint
and integration exit0. UI210/1614+TS. FR/ZH transfer label added after native runner,
covered by final UI typecheck/tests; no four-language native claim. SLICE_2AN and
evidence/s2an.json. Outgoing DJ disabled until workspace restore complete. Next
DJ/Radio/pending catalog and device reconnect exhaustion; then remaining public
invites/pairing, DJ/Auto negatives, distribution, principal/browser4. Continue.

S2ao accepted: shared auto workspace restored in native dual decoders at index/
position with source trays/direction/profile/heard/avoid/exploration and proposals.
Wire transition fromKey = musical identity, native fromKey = preceding occurrence;
bridge owners remapped; public plan labels preserved. Genuine Core handoff marker
prevents same-queue resume optimization discarding edits from another device.
Native DJ background controls and incoming/outgoing PCM/socket contract, returned
direction edit and malformed-profile refusal pass HTTP/TLS; combined6/0,51.706s;
Core16/0; runner exit0 + normal APK/test/JVM56/lint. SLICE_2AO/evidence/s2ao.json.
NORMAL test seeks shortened for independence from short PCM fixtures; historical
54s/123s evidence unchanged. Next Radio workspace + pending catalog resolution,
device reconnection exhaustion, public invites/pairing, broader negatives,
distribution and final principal/browser4. Do not merge/automerge/publish.

S2ap accepted: Radio seed/profile/intent and generated occurrence ownership survive
incoming/outgoing NORMAL handoff; Stop keeps manual future and current identity.
Autoplay imported markers obey receiver account setting; disabled strips only its
runway. Shared radio fields active/seedId; profile/seed are native extensions,
balanced default for web/common snapshots. Context metadata + identity/loudness
facts retained for imported NORMAL. DeviceRadio+DeviceDj+DeviceSession+DevicesUi
8/0 HTTP/TLS,86.694s; exit0 + normal APK/test/JVM56/lint. See SLICE_2AP/evidence.
Next device reconnect exhaustion and deferred catalog playback/handoff, then
public invites/pairing, broader negatives, distribution and final full suites.
Continue; no PR merge/automerge/publication. Last UI complete210/1614+TS unchanged.

S2aq accepted: exhausted device Socket.IO manager is retired and retried after30s
cooldown with cookie/profile revalidation and stable UUID. Actor reset removes
manager callbacks. Activity-closed real transport503 exhaustion/recovery while
20s PCM repeats, same device registration/publication and restored remote controls
HTTP/TLS2/0; exit0 + normal APK/test/JVM56/lint. SLICE_2AQ/evidence/s2aq.json.
Initial fixture-path test issue corrected with raw test client; no production
path restriction weakened. Next deferred catalogue: retain pending entries and
resolve in native source loader, generation/occurrence guarded, no web audio.
Then public invites/pairing, broader negatives, distribution and final full suites.

## Recuperación del entorno tras reinicio

Workspace vigente: `/mnt/storage/Git-projects-storage/soundsible` en HDD ext4
`/dev/sda1`, montado rw. El 2026-10-06 se verificó escritura/lectura/fsync y fetch
de GitHub; HEAD b119384d ya estaba en remoto. `/home/arsu/soundsible` era un
clone limpio de junio (`new-ui`, HEAD 3e4a961, ancestro del trabajo vigente),
sin commits exclusivos ni archivos no ignorados pendientes. Eliminado a petición
del usuario; `.claude`, `.gstack` y `.env` ignorado se preservaron fuera del repo
en `/mnt/storage/Git-projects-storage/recovered-soundsible-home`. No copiar ese
backup sobre el trabajo vigente ni publicar su contenido. AVD API36 reiniciado.
Los logs `/tmp` anteriores no sobreviven al reinicio; evidence JSON y commits
conservan los resultados históricos, no afirmar que se rerunearon.

S2ar validado: catálogo pendiente en NORMAL y colecciones UI, source loader Core
con Activity cerrada, identidad/contexto conservados, replay sin matcher extra y
reset durante matcher lento sin resurrección. DeviceCatalogSession2 +
CollectionProfile4 + CatalogSearch2 HTTP/TLS8/0,95.019s; runner exit0 y normal
APK/test APK/JVM56/lint. WholeUI210/1616 + TS pasan. Log
`/tmp/soundsible-deferred-native.log`, SLICE_2AR/evidence/s2ar.json.
Siguiente inmediato: matcher404 debe continuar colección; retry temporal acotado,
menús DJ/Radio no deben convertir pendientes en source local. Luego OS invites/
pairing, negativos DJ/Auto, firma/distribución y principal/browser4 final.
PR manual, no merge/automerge/publicación.

S2as validado: matcher404 continúa hacia siguiente canción; dos retries503
recuperan PCM y tres intentos agotan estable; Retry explícito conserva fila y
recupera. HTTP/TLS2/0,51.339s + runner exit0 y normal APK/test APK/JVM56/lint.
WholeUI210/1617+TS; Core fixture1/0. SLICE_2AS/evidence/s2as.json.
Siguiente: guard del menú de ocurrencia pendiente (AndroidStart reconstruye
actualmente fallback sin pendingResolve), e invites VIEW/SEND con acción explícita
sin cambiar cuenta/origen al recibirlos. Luego pairing/negativos/firma/final.

S2at validado (Claude Code toma el relevo de Codex): invite compartido por SEND es
propuesta; sin sesión Conectar, con sesión aviso + «Usar invitación» cierra sesión
explícitamente (Android hace la elección, no copia el descarte web). Menú de
ocurrencia pendiente sólo retira (negativo verificado). Combinado8/0 HTTP/TLS,
66.403s, runner exit0 + APK/test APK/JVM56/lint; UI211/1620+TS. SLICE_2AT/
evidence/s2at.json. Paridad = funciones: si la web usa un apaño por limitación
del navegador, Android lo hace de la mejor manera nativa. Siguiente: puente
público/App Links (VIEW https), negativos DJ/Auto, firma/distribución y
regresión final principal/browser4. PR manual, no merge/automerge/publicación.

S2au validado: Settings nativo con Biblioteca, Descargas (admin), Comunidad,
Acerca de y Dispositivos (nombre por instalación + emparejados). Vistas extraídas
de SettingsSections y compartidas con la web. Nombre por defecto del sistema y
re-registro inmediato. Bloque22/0 HTTP/TLS,280.499s + normal; UI213/1631+TS.
SLICE_2AU/evidence/s2au.json. Pendiente de decisión del usuario: emparejar este
teléfono por QR (lado reclamante, no existe en web). Siguiente: inventario de
paridad restante (biblioteca/búsqueda/cola/podcasts), negativos DJ/Auto, firma y
regresión final principal/browser4. PR manual, no merge/automerge/publicación.
