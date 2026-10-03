# S2k: primer vertical de podcasts (pendiente de implementación)

## Resultado que debe demostrar

Desde suscripciones de la cuenta, abrir episodios y reproducir uno con el mismo
Media3 del programa NORMAL. Pausar, avanzar/retroceder quince segundos, reabrir la
actividad y continuar desde progreso real. Una copia adquirida y el streaming del
mismo enclosure deben compartir progreso. Este documento es scaffolding de trabajo,
no evidencia ni capacidad implementada. S2j está cerrado; no marcar S2k como hecho.

## Referencias verificadas

- `ui_web/src/mobile/AndroidStart.tsx`: refresh transforma tracks con
  `musicLibraryRows`; conservar por separado episodios adquiridos y subscriptions.
- `ui_web/src/lib/api.ts`: LibrarySnapshot, getPodcastEpisodes, browsePodcastFeed,
  podcastPeek y subscribe/unsubscribe; aprovechar transporte nativo ya instalado.
- `ui_web/src/lib/track.ts`: podcastEpisodeToTrack conserva GUID, feed y enclosure.
- `ui_web/src/lib/podcastProgress.ts`: contrato web de progreso; máximo 500,
  completados vuelven a cero, identidad enclosure primero y feed/GUID después.
  No importar `stores/podcasts.ts`: depende del audio web.
- `shared/api/routes/podcasts.py`: POST enclosure/peek minta token; GET stream/token
  valida URL, reenvía Range y entrega status/headers del proveedor. Probar estas
  rutas reales; nunca enviar cookie de sesión al enclosure.
- `shared/podcast_preview_token.py`: token firmado con TTL; no confundirlo con ID
  de episodio ni UUID de ocurrencia.
- `ProgramQueue.kt`: local/preview e id máximo 512 actualmente. Un GUID/enclosure
  requiere descriptor propio; no ampliar el regex de vídeo para introducir URLs.
- PlaybackService/PlaybackPlugin y `lib/program/runtime.ts`: un solo dueño de audio,
  comandos y snapshots guardados por generación, ocurrencia y token de cola.

## Implementación en orden

1. Inventariar fuentes y adquisición podcast reales; mantener música y episodios
   distinguidos en snapshot de biblioteca. Añadir navegación de shows/episodios
   reutilizando filas/textos compartidos, con estados vacíos, carga y Retry.
2. Definir descriptor podcast tipado y acotado. Nativo minta/valida token mediante
   API del origen verificado y construye su URI interna. No recibir URL de audio
   arbitraria por puente. Validar todo antes de reemplazar el programa; rechazar
   episodios remotos sin sesión aunque exista perfil offline de música.
3. Persistir progreso privado por origen y cuenta confirmada. Identidad estable
   de enclosure, fallback feed/GUID; jamás token/ocurrencia. Servicio guarda durante
   playback/background y en pausa/seek/cambio/fin. Limitar registros, clamp a duración
   conocida, tolerar almacenamiento dañado. Al completar, seleccionar empieza cero.
4. Comandos ±15s en looper del player con sus posiciones reales; límites de cero/
   duración y disponibilidad seekable. UI muestra estado confirmado, sin estimar
   posición final desde un snapshot antiguo. Controles remotos coherentes.
5. Expiración de token y preparación: renovación acotada sólo para ocurrencia/
   generación vigente, conservando posición e intención de pausa. Logout, nueva
   cuenta, nuevo episodio y cierre invalidan toda resolución pendiente. No convertir
   cada 403 en retry infinito; distinguir revocación de sesión y token caducado.
6. Fixture desechable sustituye sólo RSS/enclosure externo; parser/token/proxy/
   Range/roles siguen reales. Usar audio sintético y auditoría sin credenciales.
   No debilitar SSRF de producción para aceptar localhost del fixture.

## Aceptación necesaria para cerrar

- Unit: joins streaming/adquirido, aislamiento origen/cuenta, límite/validación de
  progreso, completion, renovación cancelada y comandos fuera de orden.
- Python: feed/episodios y proxy reales, Range 206 y headers, token inválido/caducado,
  cuenta/roles, ausencia de cookie al proveedor y cierre del lector upstream.
- APK HTTP y HTTPS verificado: suscripción → episodio → audio nativo; resume,
  ±15s, pausa durante preparación, recreación/background, cuenta alternada y cierre.
- Integración completa con S1–S2j/S6a conservados; reset explícito de cache sintética
  antes de pruebas que requieren fuentes frías, sin debilitar sus assertions.
- Whole npm test y cuatro perfiles browser antes del PR acumulado. APK normal sin
  CA de fixture, metadata HEAD limpia, firma debug comprobada, evidencia y handoff.

## Fuera de este primer vertical, todavía exigido por paridad

Directorio/búsqueda, follow/unfollow, adquisición y acciones completas de podcasts
se contabilizan expresamente en la matriz según lo realmente validado. Offline B
cubre sólo música adquirida: no introducir copia podcast implícita. Carátulas
externas requieren el transporte seguro correspondiente, sin cookies a hosts RSS.

Radio es recomendaciones musicales NORMAL: ver `startRadio` en stores/dj.ts y
GeneratedQueueController. Auditar después de podcasts; conservar seed en playback
sin reiniciar, inserciones manuales y planificación fiable en background. No crear
un directorio de estaciones como sustituto. DJ/Live/Auto y firma/actualización
siguen siendo gates independientes; este vertical no habilita alpha ni merge.
