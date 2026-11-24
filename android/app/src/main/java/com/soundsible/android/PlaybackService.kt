package com.soundsible.android

import android.app.PendingIntent
import android.content.Intent
import android.content.Context
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.audio.AudioOffloadSupport
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import android.os.Bundle
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl

/** One program, independent of the Activity. Queue survives Activity recreation, not process death. */
@UnstableApi
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private lateinit var player: ProgramPlayerRouter
    private lateinit var normalFactory: () -> ExoPlayer
    private lateinit var djPlanner: ProgramDjPlanner
    private var liveListener: NativeLivePlayer? = null
    private var dj: ProgramDjSession? = null
    private var djRouteEditor: ProgramDjRouteEditor? = null
    private var djPhase = "idle"
    private var djError = 0
    private var djRefiner: ProgramDjRefiner? = null
    private var refillAnchor = ""
    private lateinit var connection: EngineConnection
    private lateinit var leveling: ProgramAudioPreference
    private lateinit var mixing: ProgramAudioPreference
    private val pcmTap = ProgramPcmTap()
    private lateinit var previews: PreviewProgram
    private lateinit var radio: RadioProgram
    private lateinit var autoplay: AutoplayProgram
    private lateinit var podcasts: PodcastProgressStore
    private val progressTicker = object : Runnable { override fun run() { if (session != null) { savePodcast(); maybeRefill(); main.postDelayed(this, 5000) } } }
    private fun savePodcast() { if (::player.isInitialized && ::podcasts.isInitialized) podcasts.save(player.currentMediaItem, player.currentPosition, player.duration, player.playbackState == Player.STATE_ENDED) }
    private val catalogCache = java.util.concurrent.ConcurrentHashMap<String, String>()
    private lateinit var installDj: (List<ProgramDjSession.Row>, Long, Int, Set<String>) -> Unit
    private lateinit var deviceSession: NativeDeviceSession
    private var pendingImport: (() -> Unit)? = null
    private lateinit var liveHost: NativeLiveHost
    private lateinit var carArt: ProgramCarArtwork
    private lateinit var carLibrary: ProgramCarLibrary
    private lateinit var carSubscriptions: ProgramCarSubscriptions
    private var pendingCarRadio: String? = null
    private lateinit var artwork: ProgramArtwork
    @Volatile private var transport: Pair<Long, OkHttpClient>? = null
    private val networkCleanup = java.util.concurrent.Executors.newSingleThreadExecutor { task ->
        Thread(task, "soundsible-programme-net-close").apply { isDaemon = true }
    }
    /** TLS close_notify can write to the socket; never evict a pool on the player looper. */
    private fun retireTransport() {
        val client = synchronized(this) { transport?.second.also { transport = null } } ?: return
        networkCleanup.execute {
            try { client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
            finally { client.dispatcher.executorService.shutdown() }
        }
    }
    private val audioCalls = java.util.concurrent.ConcurrentHashMap<okhttp3.Call, String>()
    private val podcastSources = java.util.concurrent.ConcurrentHashMap<PodcastDataSource, String>()
    private val connectedCalls = java.util.concurrent.ConcurrentHashMap.newKeySet<okhttp3.Call>()
    private fun cancelAudio(key: String? = null) { podcastSources.entries.filter { key == null || it.value == key }.forEach { it.key.cancel() }; audioCalls.entries.filter { key == null || it.value == key }.forEach { it.key.cancel() } }
    private val main = Handler(Looper.getMainLooper())
    private val reset: () -> Unit = {
        cancelAudio()
        retireTransport()
        main.post { if (session != null) { carSubscriptions.reset(); carArt.clear(); carLibrary.reset(); closeProgram() } }
    }
    /** On the player looper; does not touch account generation, cookie or library. */
    private fun closeProgram() {
        pendingImport?.invoke(); pendingImport = null
        pendingCarRadio = null
        djRefiner?.clear()
        djRouteEditor?.clear()
        catalogCache.clear()
        djPlanner.clear(); refillAnchor = ""
        restoreNormal()
        publishDj("idle", 0)
        savePodcast()
        autoplay.clear()
        leveling.clear(); mixing.clear()
        radio.clear()
        previews.clear()
        player.pause(); player.stop(); player.clearMediaItems()
        // stop retains a previous playback error. Preparing an empty timeline clears it without a source.
        if (player.playerError != null) { player.prepare(); player.stop() }
        player.shuffleModeEnabled = false; player.repeatMode = Player.REPEAT_MODE_OFF
        artwork.clear()
        cancelAudio()
        retireTransport()
        // Media3 removes the notification/foreground when its timeline is empty.
        triggerNotificationUpdate()
    }
    private fun publishDj(phase: String, code: Int) {
        djPhase = phase; djError = code
        if (::djPlanner.isInitialized) dj?.let(djPlanner::syncWork)
        if (::deviceSession.isInitialized) {
            val mixingNow = dj?.transitionState()?.optString("status") == "mixing"
            deviceSession.changed(immediate = mixingNow)
        }
        session?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putLong("djGeneration", connection.generation); putBoolean("djActive", dj != null)
            putString("djPhase", phase); putInt("djErrorStatus", code)
            putLong("djEditRevision", djRouteEditor?.revision ?: 0)
            putInt("djEditableFrom", dj?.editableFrom() ?: 0)
            putString("djProtectedKeys", org.json.JSONArray(dj?.protectedKeys()?.toList() ?: emptyList<String>()).toString())
            putString("djEditOutcome", djRouteEditor?.outcome ?: "idle")
            putString("djRequestTitle", djRouteEditor?.requestTitle ?: "")
            putString("djSources", djPlanner.sources.toString())
        }) }
    }
    private fun maybeRefill() {
        val owner = dj ?: return
        djPlanner.syncWork(owner)
        if (djPlanner.busy() || djRouteEditor?.busy() == true || !player.playWhenReady || owner.items().size - owner.currentIndex() - 1 > 3) return
        val anchor = owner.items().lastOrNull() ?: return
        val key = anchor.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: return
        val marker = key + ":" + ProgramQueue.token(player)
        if (refillAnchor == marker) return
        refillAnchor = marker
        djPlanner.start(djPlanner.sources, true, ProgramDjPlanner.Kind.APPEND, anchor)
    }
    private fun restoreNormal() {
        djRefiner?.clear()
        djPlanner.releaseWork()
        val previous = dj
        val listener = liveListener
        if (previous == null && listener == null) return
        player.pause(); player.stop()
        val normal = normalFactory().apply { volume = player.volume }
        player.replaceBackend(normal)
        previous?.close(); listener?.release(); dj = null; liveListener = null
    }
    private fun retireSource(args: Bundle) {
        require(args.getLong("generation", -1) == connection.generation)
        val id = args.getString("id") ?: error("NO_SOURCE")
        val rows = (0 until player.mediaItemCount).map { index ->
            val item = player.getMediaItemAt(index)
            SourceRetirement.Reference(item.mediaId, item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) ?: "")
        }
        if (dj != null) { djRouteEditor?.clear(); djPlanner.clear(); refillAnchor = ""; dj!!.retire(id); if (player.mediaItemCount == 0) closeProgram(); else maybeRefill(); return }
        val ranges = SourceRetirement.ranges(rows, id)
        val keys = ranges.flatMap { range -> range.map { ProgramQueue.key(player, it) } }
        savePodcast(); radio.retire(id); autoplay.retire(id)
        if (ranges.sumOf { it.count() } == player.mediaItemCount) closeProgram()
        else {
            ranges.forEach { player.removeMediaItems(it.first, it.last + 1) }
            keys.forEach(::cancelAudio)
            previews.sync(); radio.sync(); autoplay.sync()
        }
    }
    override fun onCreate() {
        super.onCreate()
        connection = EngineConnection.shared(this)
        artwork = ProgramArtwork(connection)
        podcasts = PodcastProgressStore(this)
        val factory = androidx.media3.datasource.DataSource.Factory {
            // Each source pins the selected account; every HTTP request revalidates it.
            val epoch = connection.generation
            val selected = connection.origin
            val client = synchronized(this) { transport?.takeIf { it.first == epoch }?.second ?: okhttp3.ConnectionPool().let { pool -> connection.client.newBuilder()
                .dispatcher(okhttp3.Dispatcher()).connectionPool(pool)
                .retryOnConnectionFailure(false).eventListener(object : okhttp3.EventListener() {
                override fun callStart(call: okhttp3.Call) { audioCalls[call] = call.request().url.queryParameter("android_occurrence") ?: "" }
                override fun connectStart(call: okhttp3.Call, address: java.net.InetSocketAddress, proxy: java.net.Proxy) { connectedCalls.add(call) }
                override fun callEnd(call: okhttp3.Call) { audioCalls.remove(call); connectedCalls.remove(call) }
                override fun callFailed(call: okhttp3.Call, ioe: java.io.IOException) { audioCalls.remove(call); connectedCalls.remove(call) }
            }).addInterceptor { chain ->
                if (epoch != connection.generation || selected != connection.origin || chain.request().url.queryParameter("android_generation") != epoch.toString()) throw java.io.IOException("STALE_SESSION")
                val cookie = connection.cookieHeader(epoch) ?: throw java.io.IOException("NO_SESSION")
                val request = chain.request().newBuilder().url(chain.request().url.newBuilder().removeAllQueryParameters("android_generation").removeAllQueryParameters("android_occurrence").build()).header("Cookie", cookie).build()
                val response = try { chain.proceed(request) } catch (failure: java.io.IOException) {
                    // Never replay a body or an HTTP error. OkHttp has retired this
                    // failed pooled socket; the idle ones are likely as stale, so the
                    // new exchange opens a fresh socket and rechecks the account.
                    val connected = connectedCalls.contains(chain.call())
                    if (BuildConfig.DEBUG) android.util.Log.d("AudioConnection", "Headers failed; connected=$connected cancelled=${chain.call().isCanceled()}")
                    if (request.method != "GET" || !AudioConnectionRepair.allowed(failure, connected, false, chain.call().isCanceled()) || epoch != connection.generation || selected != connection.origin) throw failure
                    pool.evictAll()
                    chain.proceed(request)
                }
                if (epoch != connection.generation) { response.close(); throw java.io.IOException("STALE_SESSION") }
                if (response.isSuccessful && ::previews.isInitialized) previews.loaded(chain.request().url.queryParameter("android_occurrence") ?: "")
                if (response.code == 401) main.post { if (epoch == connection.generation) player.pause() }
                response
            }.build() }
                .also { transport = epoch to it }
            }
            OkHttpDataSource.Factory(client).createDataSource()
        }
        val resolved = androidx.media3.datasource.DataSource.Factory { OfflineDataSource(connection, factory) }
        val localFactory = DefaultMediaSourceFactory(resolved).setLoadErrorHandlingPolicy(object : androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(0) {
            override fun getRetryDelayMsFor(loadErrorInfo: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET
        })
        val sources = object : androidx.media3.exoplayer.source.MediaSource.Factory {
            override fun setDrmSessionManagerProvider(provider: androidx.media3.exoplayer.drm.DrmSessionManagerProvider) = apply { localFactory.setDrmSessionManagerProvider(provider) }
            override fun setLoadErrorHandlingPolicy(policy: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy) = apply { localFactory.setLoadErrorHandlingPolicy(policy) }
            override fun getSupportedTypes() = localFactory.supportedTypes
            override fun createMediaSource(item: MediaItem): androidx.media3.exoplayer.source.MediaSource {
                val extras = item.mediaMetadata.extras
                if (item.localConfiguration?.uri?.pathSegments?.take(2) == listOf("api", "native-pending")) {
                    val epoch = item.localConfiguration!!.uri.getQueryParameter("android_generation")?.toLongOrNull() ?: -1
                    val identity = connection.sessionIdentity(epoch)
                    val pendingFactory = androidx.media3.datasource.DataSource.Factory {
                        CatalogDataSource(connection, factory, item, { updated -> main.post {
                            if (epoch == connection.generation && connection.sessionIdentity(epoch) == identity && dj == null) {
                                val key = updated.mediaMetadata.extras?.getString(ProgramQueue.KEY)
                                val index = (0 until player.mediaItemCount).firstOrNull { ProgramQueue.key(player, it) == key }
                                if (index != null) player.replaceMediaItem(index, updated)
                            }
                        } }, catalogCache)
                    }
                    return androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(pendingFactory, PreviewExtractors())
                        .setLoadErrorHandlingPolicy(object : androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(2) {
                            private val retry = PreviewRetry(android.os.SystemClock::elapsedRealtime, System::currentTimeMillis)
                            override fun getRetryDelayMsFor(info: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo): Long {
                                if (epoch != connection.generation || runCatching { connection.sessionIdentity(epoch) }.getOrNull() != identity) return C.TIME_UNSET
                                val error = generateSequence(info.exception as Throwable) { it.cause }.filterIsInstance<androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException>().firstOrNull()
                                return if (error != null) {
                                    val header = error.headerFields.entries.firstOrNull { it.key.equals("Retry-After", true) }?.value?.firstOrNull()
                                    retry.delay(if (error.responseCode in 500..599) 503 else error.responseCode, header) ?: C.TIME_UNSET
                                } else if (info.errorCount <= 2 && generateSequence(info.exception as Throwable) { it.cause }.none { it is javax.net.ssl.SSLException } &&
                                    generateSequence(info.exception as Throwable) { it.cause }.any { it is java.net.SocketException || it is java.net.SocketTimeoutException }) (info.errorCount * 2000L) else C.TIME_UNSET
                            }
                        }).createMediaSource(item)
                }
                if (extras?.getString(ProgramQueue.SOURCE) == "podcast") {
                    val podcastFactory = androidx.media3.datasource.DataSource.Factory { run { val key = extras.getString(ProgramQueue.KEY) ?: ""; lateinit var source: PodcastDataSource
                        source = PodcastDataSource(connection, factory, extras.getString(ProgramQueue.ENCLOSURE) ?: error("NO_ENCLOSURE"), item.localConfiguration?.uri?.getQueryParameter("android_generation")?.toLongOrNull() ?: -1, key, { podcastSources[it] = key }) { podcastSources.remove(source) }
                        source } }
                    return DefaultMediaSourceFactory(podcastFactory).setLoadErrorHandlingPolicy(object : androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(0) { override fun getRetryDelayMsFor(loadErrorInfo: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET }).createMediaSource(item)
                }
                return if (extras?.getString(ProgramQueue.SOURCE) == "preview")
                    androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(factory, PreviewExtractors()).setLoadErrorHandlingPolicy(
                        previews.policy(extras.getString(ProgramQueue.KEY) ?: "", connection.generation)).createMediaSource(item)
                else localFactory.createMediaSource(item)
            }
        }
        NativeProgramOutput.bind(pcmTap) { connection.generation }
        leveling = ProgramAudioPreference(this, connection, main, "volume_leveling", "leveling", { session })
        mixing = ProgramAudioPreference(this, connection, main, "dj_mixing", "mixing", { session }) {
            if (::deviceSession.isInitialized) deviceSession.changed(immediate = false)
        }
        val processor = ProgramPcmProcessor({ connection.generation }, leveling::active, { leveling.shuffle }, pcmTap)
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParams: Boolean): AudioSink {
                val sink = DefaultAudioSink.Builder(context).setEnableFloatOutput(false)
                    .setEnableAudioOutputPlaybackParameters(false).setAudioProcessors(arrayOf(processor)).build()
                return object : ForwardingAudioSink(sink) {
                    override fun supportsFormat(format: Format) = format.sampleMimeType == MimeTypes.AUDIO_RAW && super.supportsFormat(format)
                    override fun getFormatSupport(format: Format): Int = if (format.sampleMimeType == MimeTypes.AUDIO_RAW) super.getFormatSupport(format) else AudioSink.SINK_FORMAT_UNSUPPORTED
                    override fun getFormatOffloadSupport(format: Format) = AudioOffloadSupport.DEFAULT_UNSUPPORTED
                    override fun setOffloadMode(offloadMode: Int) { super.setOffloadMode(AudioSink.OFFLOAD_MODE_DISABLED) }
                }
            }
        }
        normalFactory = { ExoPlayer.Builder(this, renderers).setMediaSourceFactory(sources)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setSeekBackIncrementMs(15000).setSeekForwardIncrementMs(15000)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build() }
        player = ProgramPlayerRouter(normalFactory())
        previews = PreviewProgram(connection, player, main, { session }) { key -> cancelAudio(key) }
        radio = RadioProgram(connection, player, main, session = { session }, onChanged = {
            if (::deviceSession.isInitialized) deviceSession.changed(immediate = false)
        })
        autoplay = AutoplayProgram(connection, player, main, { session }, { radio.active() || dj != null })
        installDj = { rows, position, index, heard ->
            val epoch = connection.generation
            val identity = connection.sessionIdentity(epoch)
            val next = ProgramDjSession(this, epoch, { epoch == connection.generation && runCatching { connection.sessionIdentity(epoch) }.getOrNull() == identity },
                sources, pcmTap, leveling::active, rows, position, mixing = mixing::active, refine = { djRefiner?.refine(it) }, changed = { publishDj(djPhase, djError) }, startIndex = index, initialHeard = heard)
            autoplay.clear(); radio.clear()
            val resume = player.playWhenReady || rows.firstOrNull()?.kind != "user"
            val previousDj = dj; dj = next
            player.pause(); player.stop()
            val volume = player.volume
            val previous = player.replaceBackend(next.player)
            if (previousDj != null) previousDj.close() else previous.release()
            next.player.volume = volume
            if (resume) next.player.play()
            publishDj(djPhase, djError); refillAnchor = ""
        }
        djPlanner = ProgramDjPlanner(connection, player, main, { dj?.heardIds() ?: emptySet() }, ::publishDj) { rows, position, kind ->
            if (kind != ProgramDjPlanner.Kind.START) {
                dj?.let { owner ->
                    if (kind == ProgramDjPlanner.Kind.APPEND) owner.append(rows.drop(1)) else { owner.replaceFuture(rows); refillAnchor = "" }
                    publishDj(djPhase, djError)
                }
            } else {
            installDj(rows, position, 0, emptySet())
            }
        }
        djRefiner = ProgramDjRefiner(connection, main, { dj }, djPlanner)
        djRouteEditor = ProgramDjRouteEditor(connection, main, { dj }, djPlanner) { phase, code -> publishDj(phase, code) }
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                if (!unplayablePending(error)) return
                val epoch = connection.generation
                val key = ProgramQueue.key(player, player.currentMediaItemIndex)
                main.post {
                    if (epoch != connection.generation || dj != null || player.currentMediaItemIndex < 0 || ProgramQueue.key(player, player.currentMediaItemIndex) != key || player.playerError !== error) return@post
                    val at = player.currentMediaItemIndex
                    val next = player.nextMediaItemIndex
                    val resume = player.playWhenReady
                    player.removeMediaItem(at)
                    if (next != C.INDEX_UNSET && next != at && player.mediaItemCount > 0) {
                        player.seekTo(if (next > at) next - 1 else next, 0)
                        player.prepare()
                        if (resume) player.play() else player.pause()
                    } else player.stop()
                }
            }
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                if (item?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) == "preview") artwork.clear()
                previews.sync()
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && item?.mediaMetadata?.extras?.getBoolean(ProgramQueue.PODCAST) == true) {
                    val resume = podcasts.position(item); if (resume > 0) player.seekTo(resume)
                }
            }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                podcasts.save(oldPosition.mediaItem, oldPosition.positionMs, if (oldPosition.mediaItem == player.currentMediaItem) player.duration else -1, reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION)
            }
            override fun onShuffleModeEnabledChanged(shuffleModeEnabled: Boolean) { leveling.shuffle = shuffleModeEnabled }
            override fun onEvents(player: Player, events: Player.Events) {
                NativeProgramOutput.playbackChanged(player.isPlaying)
                if (::deviceSession.isInitialized) {
                    val transport = events.containsAny(
                        Player.EVENT_IS_PLAYING_CHANGED,
                        Player.EVENT_PLAY_WHEN_READY_CHANGED,
                        Player.EVENT_PLAYBACK_STATE_CHANGED,
                        Player.EVENT_POSITION_DISCONTINUITY,
                        Player.EVENT_MEDIA_ITEM_TRANSITION,
                        Player.EVENT_PLAYER_ERROR,
                    )
                    deviceSession.changed(immediate = transport)
                }
                pendingCarRadio?.let { key ->
                    if (player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.KEY) == key) {
                        pendingCarRadio = null; autoplay.suspend(); radio.start("balanced")
                    }
                }
                previews.sync(); radio.sync(); autoplay.sync(); leveling.sync(player.mediaItemCount > 0); mixing.sync(player.mediaItemCount > 0); savePodcast()
                val keys = (0 until player.mediaItemCount).map { ProgramQueue.key(player, it) }.toSet()
                podcastSources.entries.filter { it.value !in keys }.forEach { it.key.cancel() }
            }
        })
        liveHost = NativeLiveHost(this, connection, main, { player }, artwork, { dj?.liveSnapshot() }) { state ->
            session?.let { active -> active.setSessionExtras(Bundle(active.sessionExtras).apply { putString("nativeLiveHost", state.toString()) }) }
        }
        deviceSession = NativeDeviceSession(this, connection, main, {
            dj?.takeIf { it.readable() }?.let { ProgramDeviceState.snapshotDj(player, it, djPlanner, djPhase, mixing.active()) }
                ?: ProgramDeviceState.snapshot(player, radio)
        }, ::executeRemoteCommand) { state ->
            session?.let { active -> active.setSessionExtras(Bundle(active.sessionExtras).apply { putString("nativeDevice", state.toString()) }) }
        }
        carArt = ProgramCarArtwork(this, connection)
        carLibrary = ProgramCarLibrary(connection, main, getString(R.string.offline_title))
        carSubscriptions = ProgramCarSubscriptions(connection, carLibrary, main) { browser, parent, count, params ->
            session?.notifyChildrenChanged(browser, parent, count, params)
        }
        connection.resetListeners.add(reset)
        session = MediaLibrarySession.Builder(this, player, object : MediaLibrarySession.Callback {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                // Same app owns queue replacement. Trusted OS controllers can control its current program.
                // Newer Android stores notification-listener authorization in
                // the system service, while Media3's legacy trust helper also
                // consults the older secure-settings list.
                val systemTrusted = android.os.Build.VERSION.SDK_INT >= 28 && controller.isPackageNameVerified && runCatching {
                    getSystemService(android.media.session.MediaSessionManager::class.java).isTrustedForMediaControl(
                        android.media.session.MediaSessionManager.RemoteUserInfo(controller.packageName, -1, controller.uid))
                }.getOrDefault(false)
                if (controller.uid != android.os.Process.myUid() && !controller.isTrusted && !systemTrusted) return MediaSession.ConnectionResult.reject()
                val commands = Player.Commands.Builder().addAllCommands()
                if (controller.uid != android.os.Process.myUid()) commands.remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
                val sessions = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                if (controller.uid == android.os.Process.myUid()) sessions.add(ProgramQueue.command)
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller).setSessionExtras(session.sessionExtras).setAvailablePlayerCommands(commands.build()).setAvailableSessionCommands(sessions.build()).build()
            }
            override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?) = carLibrary.root(params)
            override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?) =
                Futures.transform(carLibrary.children(parentId, page, pageSize, params), { result ->
                    if (result!!.resultCode != SessionResult.RESULT_SUCCESS) result
                    else androidx.media3.session.LibraryResult.ofItemList(result.value!!.map { item -> carLibrary.decorate(item, browser.packageName, carArt) }, params)
                }, { task -> main.post(task) })
            override fun onSubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, params: LibraryParams?): ListenableFuture<androidx.media3.session.LibraryResult<Void>> {
                return Futures.transform(carLibrary.children(parentId, 0, 200, params), { result ->
                    if (result!!.resultCode == SessionResult.RESULT_SUCCESS) {
                        if (!carSubscriptions.add(browser, parentId, params)) return@transform androidx.media3.session.LibraryResult.ofError(SessionError.ERROR_IO)
                        session.notifyChildrenChanged(browser, parentId, carLibrary.childCount(parentId), params)
                        androidx.media3.session.LibraryResult.ofVoid(params)
                    } else androidx.media3.session.LibraryResult.ofError(result.sessionError!!)
                }, { task -> main.post(task) })
            }
            override fun onUnsubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String): ListenableFuture<androidx.media3.session.LibraryResult<Void>> {
                carSubscriptions.remove(browser, parentId)
                return Futures.immediateFuture(androidx.media3.session.LibraryResult.ofVoid(null))
            }
            override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
                carSubscriptions.remove(controller)
            }
            override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String) =
                Futures.transform(carLibrary.item(mediaId), { result ->
                    if (result!!.resultCode != SessionResult.RESULT_SUCCESS) result
                    else androidx.media3.session.LibraryResult.ofItem(carLibrary.decorate(result.value!!, browser.packageName, carArt), result.params)
                }, { task -> main.post(task) })
            override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<androidx.media3.session.LibraryResult<Void>> =
                Futures.transform(carLibrary.search(query, 0, 200, params), { result ->
                    if (result!!.resultCode == SessionResult.RESULT_SUCCESS) {
                        session.notifySearchResultChanged(browser, query, carLibrary.searchCount(query), params)
                        androidx.media3.session.LibraryResult.ofVoid(params)
                    } else androidx.media3.session.LibraryResult.ofError(result.sessionError!!)
                }, { task -> main.post(task) })
            override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?) =
                Futures.transform(carLibrary.search(query, page, pageSize, params), { result ->
                    if (result!!.resultCode != SessionResult.RESULT_SUCCESS) result
                    else androidx.media3.session.LibraryResult.ofItemList(result.value!!.map { item -> carLibrary.decorate(item, browser.packageName, carArt) }, params)
                }, { task -> main.post(task) })
            override fun onSetMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
                val query = mediaItems.singleOrNull()?.requestMetadata?.searchQuery
                val carSelection = query != null || controller.uid != android.os.Process.myUid() || mediaItems.any { it.mediaId.startsWith("soundsible:track:") || it.mediaId.startsWith("soundsible:radio:") }
                if (!carSelection) return super.onSetMediaItems(session, controller, mediaItems, startIndex, startPositionMs)
                fun resolve(items: List<MediaItem>): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = try {
                    val selected = carLibrary.select(items)
                    require(startIndex == C.INDEX_UNSET || startIndex in selected.items.indices)
                    require(carLibrary.owns(selected))
                    val index = if (startIndex == C.INDEX_UNSET) 0 else startIndex
                    val opening = selected.items[index]
                    if ((dj != null || djPlanner.busy()) && !selected.radio && opening.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true) {
                        pendingCarRadio = null
                        startDjSelection(listOf(opening), opening.mediaMetadata.title?.toString().orEmpty())
                        // MediaSession applies this result to the new backend;
                        // retain its opening rather than reinstating the car's context queue.
                        Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(listOf(opening), 0, 0))
                    } else {
                        djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
                        restoreNormal(); publishDj("idle", 0)
                        autoplay.clear(); radio.clear(); previews.clear()
                        pendingCarRadio = if (selected.radio) selected.items.single().mediaMetadata.extras!!.getString(ProgramQueue.KEY) else null
                        val position = if (startPositionMs == C.TIME_UNSET) podcasts.position(opening) else startPositionMs.coerceAtLeast(0)
                        Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(selected.items, index, position))
                    }
                } catch (_: Exception) { Futures.immediateFailedFuture(IllegalArgumentException("Unsupported car selection")) }
                if (query != null) return Futures.transformAsync(carLibrary.search(query, 0, 200, null), { result ->
                    if (result!!.resultCode != SessionResult.RESULT_SUCCESS || result.value!!.isEmpty())
                        Futures.immediateFailedFuture(IllegalArgumentException("No acquired search result"))
                    else resolve(result.value!!.take(1))
                }, { task -> main.post(task) })
                return resolve(mediaItems)
            }
            override fun onPlayerCommandRequest(session: MediaSession, controller: MediaSession.ControllerInfo, command: Int): Int {
                val recovers = command == Player.COMMAND_PREPARE || command == Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM || command == Player.COMMAND_SEEK_TO_DEFAULT_POSITION || command == Player.COMMAND_SEEK_TO_MEDIA_ITEM || (command == Player.COMMAND_PLAY_PAUSE && !player.playWhenReady)
                if (recovers && player.playerError != null && !previews.canPrepare()) return SessionError.ERROR_BAD_VALUE
                if (command == Player.COMMAND_PREPARE && player.playerError != null) previews.manualRetry()
                if (command == Player.COMMAND_PLAY_PAUSE && !player.playWhenReady &&
                    PlaybackRecovery.kind(player.playerError) in listOf("connection", "server")) {
                    previews.manualRetry()
                    player.prepare()
                }
                return SessionResult.RESULT_SUCCESS
            }
            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (customCommand.customAction != ProgramQueue.command.customAction || controller.uid != android.os.Process.myUid()) return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                if (args.getString("action") == "deviceRename") {
                    if (args.getLong("generation", -1) != connection.generation) return Futures.immediateFuture(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                    return Futures.immediateFuture(SessionResult(if (deviceSession.rename(args.getString("name").orEmpty())) SessionResult.RESULT_SUCCESS else SessionError.ERROR_BAD_VALUE))
                }
                if (args.getString("action") == "deviceHandoff") {
                    if (args.getLong("generation", -1) != connection.generation) return Futures.immediateFuture(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                    return deviceSession.handoff(args.getString("device_id").orEmpty())
                }
                if (args.getString("action") == "retry" && liveListener != null) {
                    return Futures.immediateFuture(try {
                        require(args.getLong("generation", -1) == connection.generation && args.getString("queueToken") == ProgramQueue.token(player) && args.getString("key") == ProgramQueue.key(player, player.currentMediaItemIndex))
                        player.prepare(); player.play(); SessionResult(SessionResult.RESULT_SUCCESS)
                    } catch (_: Exception) { SessionResult(SessionError.ERROR_BAD_VALUE) })
                }
                if (args.getString("action") in listOf("liveLeave", "livePause", "liveResume", "liveVolume")) {
                    return Futures.immediateFuture(try {
                        require(args.getLong("generation", -1) == connection.generation && liveListener != null)
                        when (args.getString("action")) {
                            "liveLeave" -> closeProgram()
                            "livePause" -> player.pause()
                            "liveResume" -> player.play()
                            "liveVolume" -> { val volume = args.getFloat("volume", -1f); require(volume in 0f..1f); player.volume = volume }
                        }
                        SessionResult(SessionResult.RESULT_SUCCESS)
                    } catch (_: Exception) { SessionResult(SessionError.ERROR_BAD_VALUE) })
                }
                if (args.getString("action") == "liveListen") {
                    return Futures.immediateFuture(try {
                        require(args.getLong("generation", -1) == connection.generation)
                        val room = org.json.JSONObject(args.getString("session") ?: error("NO_LIVE_ROOM"))
                        require(room.getString("id").length in 1..128)
                        val target = room.getString("whep_url").toHttpUrl()
                        require(target.isHttps && target.username.isEmpty() && target.password.isEmpty())
                        closeProgram()
                        val listener = NativeLivePlayer(this@PlaybackService, connection, room) { state ->
                            session?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply { putString("nativeLiveListener", state.toString()) }) }
                        }.apply { volume = player.volume }
                        player.pause(); player.stop()
                        player.replaceBackend(listener).release(); liveListener = listener
                        player.prepare(); player.play()
                        SessionResult(SessionResult.RESULT_SUCCESS)
                    } catch (_: Exception) { SessionResult(SessionError.ERROR_BAD_VALUE) })
                }
                if (args.getString("action") in listOf("liveStart", "liveStop", "liveTitle", "liveChat")) {
                    if (args.getLong("generation", -1) != connection.generation) return Futures.immediateFuture(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                    return when (args.getString("action")) {
                        "liveStart" -> liveHost.start(args.getString("title").orEmpty())
                        "liveTitle" -> liveHost.title(args.getString("title").orEmpty())
                        "liveChat" -> liveListener?.chat(args.getString("text").orEmpty()) ?: liveHost.chat(args.getString("text").orEmpty())
                        else -> liveHost.stop()
                    }
                }
                return Futures.immediateFuture(try {
                    applyProgramCommand(args)
                    SessionResult(SessionResult.RESULT_SUCCESS)
                } catch (failure: Exception) {
                    if (BuildConfig.DEBUG) android.util.Log.w("ProgrammeCommand", "${args.getString("action")}:${failure.javaClass.simpleName}:${failure.stackTrace.firstOrNull { it.className.startsWith("com.soundsible.android") }}")
                    SessionResult(SessionError.ERROR_BAD_VALUE)
                })
            }
        }).setBitmapLoader(artwork).setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        main.post(progressTicker)
    }

    /** Shared by MediaSession commands from the Android UI and remote commands from other devices. */
    private fun applyProgramCommand(args: Bundle) {
        if (args.getString("action") == "djSelection") {
            // Refilling a route does not change the programme the listener chose from.
            require(args.getLong("generation", -1) == connection.generation &&
                args.getString("programToken").orEmpty() == ProgramQueue.programToken(player))
            val items = ProgramQueue.items(connection, org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACKS")))
            startDjSelection(items, args.getString("label") ?: items.first().mediaMetadata.title?.toString().orEmpty())
        } else if (args.getString("action") == "djContext") {
            require(args.getLong("generation", -1) == connection.generation && args.getString("queueToken") == ProgramQueue.token(player))
            if (player.mediaItemCount > 0) require(args.getString("key") == ProgramQueue.key(player, player.currentMediaItemIndex))
            if (dj != null) require(args.getString("programToken") == ProgramQueue.programToken(player))
            require(player.currentMediaItem?.mediaMetadata?.extras?.getBoolean(ProgramQueue.PODCAST) != true)
            val requested = org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACK")); require(requested.length() == 1)
            val track = ProgramQueue.items(connection, requested, ProgramQueue.programToken(player)).single()
            require(track.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true)
            val source = org.json.JSONObject().put("id", java.util.UUID.randomUUID().toString())
                .put("label", track.mediaMetadata.title?.toString() ?: "").put("activation", 1)
                .put("tracks", org.json.JSONArray().put(djPlanner.reference(track)))
            djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
            if (dj != null) {
                dj!!.changeContext(track)
                djPlanner.start(org.json.JSONArray().put(source), true, ProgramDjPlanner.Kind.REPLACE)
            } else {
                djPlanner.start(org.json.JSONArray().put(source), player.mediaItemCount > 0,
                    lead = track.takeIf { player.mediaItemCount > 0 })
            }
        } else if (args.getString("action") == "djRequest") {
            require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player) && args.getString("queueToken") == ProgramQueue.token(player))
            val rows = org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACK")); require(rows.length() in 1..ProgramQueue.LIMIT)
            val before = args.getString("beforeKey")?.takeIf { it.isNotBlank() }
            val tracks = ProgramQueue.items(connection, rows, ProgramQueue.programToken(player))
            require(tracks.none { it.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true ||
                it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "pending" })
            djPlanner.clear(); refillAnchor = ""
            if (tracks.size == 1) djRouteEditor!!.place(tracks.single(), before)
            else {
                // One group per collection request, carried in the route role so it also travels in handoffs.
                val group = java.util.UUID.randomUUID().toString()
                val route = org.json.JSONObject().put("kind", "user").put("placement", if (before != null) "fixed" else "dj").put("requestGroup", group).toString()
                djRouteEditor!!.placeGroup(tracks.map { item -> item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon()
                    .setExtras(android.os.Bundle(item.mediaMetadata.extras).apply { putString(ProgramQueue.ROUTE, route) }).build()).build() }, before)
            }
        } else if (args.getString("action") == "djRepair") {
            require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player) && args.getString("queueToken") == ProgramQueue.token(player))
            djPlanner.clear(); refillAnchor = ""
            djRouteEditor!!.repair()
        } else if (args.getString("action") == "djSettings") {
            require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player))
            refillAnchor = ""
            djRouteEditor?.clear()
            if (args.getBoolean("resetRequestGroups")) dj!!.dropRequestGroups()
            djPlanner.start(args.getString("sources")?.let { org.json.JSONArray(it) } ?: djPlanner.sources,
                true, ProgramDjPlanner.Kind.REPLACE)
        } else if (args.getString("action") == "dj") {
            require(args.getLong("generation", -1) == connection.generation)
            if (args.getBoolean("fromCurrent", true)) require(args.getString("queueToken") == ProgramQueue.token(player) && args.getString("key") == ProgramQueue.key(player, player.currentMediaItemIndex))
            djRouteEditor?.clear()
            djPlanner.start(org.json.JSONArray(args.getString("sources") ?: "[]"), args.getBoolean("fromCurrent", true))
        } else if (args.getString("action") == "queue") {
            require(args.getLong("generation", -1) == connection.generation)
            val items = ProgramQueue.items(connection, org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACKS")), contextKind = args.getString("contextKind"), contextId = args.getString("contextId"), lane = "context")
            val index = args.getInt("index", -1); require(index in items.indices)
            val position = args.getLong("positionMs", -1)
            if (position < 0 && (dj != null || djPlanner.busy()) && items[index].mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true) {
                startDjSelection(listOf(items[index]), items[index].mediaMetadata.title?.toString().orEmpty())
                return
            }
            djRouteEditor?.clear(); djPlanner.clear(); restoreNormal(); publishDj("idle", 0)
            autoplay.clear()
            radio.clear()
            player.shuffleModeEnabled = args.getBoolean("shuffle")
            player.setMediaItems(items, index, if (position >= 0) position else podcasts.position(items[index])); player.prepare(); player.play()
        } else if (args.getString("action") == "metadata") {
            ProgramMetadata.apply(player, connection, args, artwork::clear)
        } else if (args.getString("action") == "retireSource") {
            retireSource(args)
        } else if (args.getString("action") == "autoplay") {
            require(args.getLong("generation", -1) == connection.generation)
            autoplay.settings(if (args.getBoolean("reload")) null else args.getBoolean("enabled"))
        } else if (args.getString("action") in listOf("leveling", "mixing")) {
            require(args.getLong("generation", -1) == connection.generation)
            (if (args.getString("action") == "mixing") mixing else leveling).settings(if (args.getBoolean("reload")) null else args.getBoolean("enabled"))
        } else if (args.getString("action") == "radio") {
            require(args.getLong("generation", -1) == connection.generation && args.getString("queueToken") == ProgramQueue.token(player))
            args.getString("key")?.let { require(it == ProgramQueue.key(player, player.currentMediaItemIndex)) }
            if (args.getBoolean("enabled")) {
                val profile = args.getString("profile") ?: "balanced"
                require(profile in listOf("familiar", "balanced", "explore"))
                if (dj != null) exitDj(keepUserRequests = false)
                autoplay.suspend(); radio.start(profile)
            } else { radio.stop(); autoplay.sync() }
        } else if (args.getString("action") == "stop") {
            require(args.getLong("generation", -1) == connection.generation)
            // Refills retain the program identity; replacement starts another.
            // Keep the older order-based contract for callers without that identity.
            val owner = args.getString("programToken")
            if (owner != null) require(owner.isNotBlank() && owner == ProgramQueue.programToken(player))
            else require(args.getString("queueToken") == ProgramQueue.token(player))
            closeProgram()
        } else {
            ProgramQueue.edit(player, connection, args, { previews.manualRetry() }, podcasts::position, (radio.manualInsertion() ?: autoplay.manualInsertion()), dj?.editableFrom()?.minus(1), dj?.let { owner -> { action, index, target -> owner.editBlock(action, index, target) } })
            if (args.getString("action") == "move") args.getString("key")?.let { dj?.pin(it) }
        }
    }

    private fun exitDj(keepUserRequests: Boolean) {
        val owner = dj ?: error("NO_DJ")
        val current = player.currentMediaItem ?: error("NO_SEED")
        val position = player.currentPosition.coerceAtLeast(0)
        val requested = player.playWhenReady
        val survivors = if (keepUserRequests) {
            owner.routeSnapshot().rows.drop(owner.currentIndex() + 1)
                .filter { it.kind == "user" }
                .map { row ->
                    row.item.buildUpon().setMediaMetadata(row.item.mediaMetadata.buildUpon().setExtras(
                        Bundle(row.item.mediaMetadata.extras).apply {
                            putString(ProgramQueue.LANE, "manual")
                            putString(ProgramQueue.LANE_SOURCE, "library")
                            remove(ProgramQueue.ROUTE)
                            remove(ProgramQueue.BRIDGE_OWNER)
                        },
                    ).build()).build()
                }
        } else emptyList()
        djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
        restoreNormal(); publishDj("idle", 0)
        player.setMediaItems(listOf(current) + survivors, 0, position); player.prepare()
        if (requested) player.play()
    }

    /** A library selection starts fresh immediately; route edits stay within the shell. */
    private fun startDjSelection(items: List<androidx.media3.common.MediaItem>, label: String) {
        require(items.isNotEmpty() && items.none { it.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true ||
            it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "pending" })
        val source = org.json.JSONObject().put("id", java.util.UUID.randomUUID().toString())
            .put("label", label).put("activation", 1)
            .put("tracks", org.json.JSONArray(items.map(djPlanner::reference)))
        val sources = org.json.JSONArray().put(source)
        require(sources.toString().length <= 65536)
        if (liveListener != null) restoreNormal()
        djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
        installDj(listOf(ProgramDjSession.Row(items.first(), kind = "generated")), 0, 0, emptySet())
        djPlanner.start(sources, true)
    }

    private fun executeRemoteCommand(name: String, args: org.json.JSONObject, done: (String?) -> Unit) {
        if (liveListener != null && name in RemoteCommandLogic.ownQueueCommands) throw RemoteCommandRejected("invalid_state")
        if (player.mediaItemCount == 0 && name in RemoteCommandLogic.currentItemCommands) throw RemoteCommandRejected("nothing_playing")
        if (dj == null && name in RemoteCommandLogic.djSessionCommands) throw RemoteCommandRejected("invalid_state")
        fun invalid(): Nothing = throw RemoteCommandRejected("invalid")
        fun queueId(key: String) = args.optString(key).takeIf { !args.isNull(key) && it.isNotBlank() }
        fun indexOfEntry(queueId: String) = (0 until player.mediaItemCount).firstOrNull { ProgramQueue.key(player, it) == queueId }
            ?: throw RemoteCommandRejected("not_found")
        fun on() = args.opt("on") as? Boolean ?: invalid()
        fun tracks() = args.optJSONArray("tracks")?.takeIf { it.length() > 0 }?.let(RemoteCommandLogic::wireTrackRows) ?: invalid()
        fun track() = RemoteCommandLogic.wireTrackRow(args.optJSONObject("track") ?: invalid())
        fun program(action: String, fill: Bundle.() -> Unit = {}) = applyProgramCommand(Bundle().apply {
            putString("action", action); putLong("generation", connection.generation); fill()
        })
        fun entry(action: String, index: Int, fill: Bundle.() -> Unit = {}) = program(action) {
            putString("queueToken", ProgramQueue.token(player)); putInt("index", index); putString("key", ProgramQueue.key(player, index)); fill()
        }
        fun djSettings(sources: org.json.JSONArray, resetRequestGroups: Boolean) = program("djSettings") {
            putString("programToken", ProgramQueue.programToken(player))
            putString("sources", sources.toString()); putBoolean("resetRequestGroups", resetRequestGroups)
        }
        fun djSource(activation: Int): org.json.JSONObject {
            val items = ProgramQueue.items(connection, tracks(), ProgramQueue.programToken(player))
            if (items.any { it.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true ||
                    it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "pending" }) throw RemoteCommandRejected("invalid_state")
            return org.json.JSONObject().put("id", java.util.UUID.randomUUID().toString())
                .put("label", args.optString("label").trim().ifEmpty { items.first().mediaMetadata.title?.toString().orEmpty() })
                .put("activation", activation).put("tracks", org.json.JSONArray(items.map(djPlanner::reference)))
        }
        when (name) {
            "transport.play" -> entry("play", player.currentMediaItemIndex)
            "transport.pause" -> player.pause()
            "transport.next" -> {
                if (!player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)) throw RemoteCommandRejected("invalid_state")
                player.seekToNextMediaItem()
            }
            "transport.previous" -> {
                if (!player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)) throw RemoteCommandRejected("invalid_state")
                player.seekToPreviousMediaItem()
            }
            "transport.seek" -> {
                val seconds = RemoteCommandLogic.parseSeekSeconds(args) ?: invalid()
                if (!player.isCurrentMediaItemSeekable) throw RemoteCommandRejected("invalid_state")
                player.seekTo((seconds * 1000.0).toLong())
            }
            "transport.set_shuffle" -> {
                val value = on()
                if (!player.isCommandAvailable(Player.COMMAND_SET_SHUFFLE_MODE)) throw RemoteCommandRejected("invalid_state")
                player.shuffleModeEnabled = value
            }
            "transport.set_repeat" -> {
                val mode = RemoteCommandLogic.parseRepeatMode(args.optString("mode")) ?: invalid()
                if (!player.isCommandAvailable(Player.COMMAND_SET_REPEAT_MODE)) throw RemoteCommandRejected("invalid_state")
                player.repeatMode = mode
            }
            "play.tracks" -> {
                val rows = tracks()
                val index = (args.opt("index") as? Number)?.toInt()?.takeIf { it in 0 until rows.length() } ?: invalid()
                val context = args.optJSONObject("context")
                val contextKind = context?.optString("kind")?.takeIf { it in listOf("album", "artist", "playlist") }
                val contextId = context?.optString("id")?.takeIf { contextKind != null && it.isNotBlank() && it.length <= 512 }
                program("queue") {
                    putString("tracks", rows.toString()); putInt("index", index)
                    if (contextId != null) { putString("contextKind", contextKind); putString("contextId", contextId) }
                }
            }
            "queue.add" -> {
                val rows = org.json.JSONArray().put(track())
                val at = args.optString("at").takeIf { it == "next" || it == "end" } ?: invalid()
                when {
                    dj != null -> program("djRequest") {
                        putString("programToken", ProgramQueue.programToken(player)); putString("queueToken", ProgramQueue.token(player))
                        putString("tracks", rows.toString())
                    }
                    at == "next" && player.mediaItemCount > 0 -> entry("insertAfter", player.currentMediaItemIndex) { putString("tracks", rows.toString()) }
                    at == "next" -> program("insertAfter") {
                        putString("queueToken", ProgramQueue.token(player)); putInt("index", -1); putString("key", ""); putString("tracks", rows.toString())
                    }
                    else -> program("append") { putString("queueToken", ProgramQueue.token(player)); putString("tracks", rows.toString()) }
                }
            }
            "queue.move" -> {
                val moving = queueId("queue_id") ?: invalid()
                val before = queueId("before_queue_id")
                val from = indexOfEntry(moving)
                val beforeIndex = before?.let(::indexOfEntry)
                val owner = dj
                val target = if (owner == null) RemoteCommandLogic.normalMoveTarget(player.mediaItemCount, from, beforeIndex)
                else when (val plan = RemoteCommandLogic.djMoveTarget(owner.policyRows(), moving, before, owner.editableFrom(), owner.protectedKeys())) {
                    RemoteCommandLogic.DjMovePlan.Locked -> throw RemoteCommandRejected("locked")
                    RemoteCommandLogic.DjMovePlan.NoOp -> null
                    is RemoteCommandLogic.DjMovePlan.Move -> plan.toIndex
                }
                if (target != null) entry("move", from) { putInt("toIndex", target) }
            }
            "queue.remove" -> {
                val removed = queueId("queue_id") ?: invalid()
                val index = indexOfEntry(removed)
                dj?.let { owner ->
                    if (RemoteCommandLogic.djRemoveLocked(owner.policyRows(), removed, owner.protectedKeys())) throw RemoteCommandRejected("locked")
                }
                entry("remove", index)
            }
            "queue.play_entry" -> entry("select", indexOfEntry(queueId("queue_id") ?: invalid()))
            "radio.start" -> {
                val item = ProgramQueue.items(connection, org.json.JSONArray().put(track()), lane = "context").single()
                if (item.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true ||
                    item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "pending" ||
                    connection.cookieHeader(connection.generation) == null) {
                    throw RemoteCommandRejected("invalid_state")
                }
                val sameCurrent = dj == null && liveListener == null && player.mediaItemCount > 0 &&
                    player.currentMediaItem?.mediaId == item.mediaId &&
                    player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) ==
                        item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE)
                if (!sameCurrent) {
                    djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
                    restoreNormal(); publishDj("idle", 0)
                    autoplay.clear(); radio.clear()
                    player.setMediaItems(listOf(item), 0, 0); player.prepare(); player.play()
                } else if (!player.playWhenReady) {
                    player.play()
                }
                entry("radio", player.currentMediaItemIndex) { putBoolean("enabled", true); putString("profile", radio.currentProfile()) }
            }
            "radio.stop" -> program("radio") { putBoolean("enabled", false); putString("queueToken", ProgramQueue.token(player)) }
            "dj.start" -> {
                val rows = tracks()
                val label = args.optString("label").trim().takeIf { it.isNotEmpty() }
                program("djSelection") {
                    putString("programToken", ProgramQueue.programToken(player)); putString("tracks", rows.toString())
                    if (label != null) putString("label", label)
                }
            }
            "dj.start_from_current" -> if (dj == null) entry("dj", player.currentMediaItemIndex) { putBoolean("fromCurrent", true) }
            "dj.stop" -> exitDj(keepUserRequests = true)
            "dj.place" -> {
                val before = queueId("before_queue_id")
                val rows = tracks()
                if (before != null) {
                    indexOfEntry(before)
                    if (dj!!.requestDestination(before) == null) throw RemoteCommandRejected("locked")
                }
                program("djRequest") {
                    putString("programToken", ProgramQueue.programToken(player)); putString("queueToken", ProgramQueue.token(player))
                    putString("tracks", rows.toString())
                    if (before != null) putString("beforeKey", before)
                }
            }
            "dj.add_source" -> {
                val current = djPlanner.sources
                val added = djSource(0)
                if (current.length() >= 64) throw RemoteCommandRejected("invalid_state")
                val activation = (0 until current.length()).maxOfOrNull { current.getJSONObject(it).optInt("activation", 0) } ?: 0
                djSettings(org.json.JSONArray(current.toString()).put(added.put("activation", activation + 1)), resetRequestGroups = false)
            }
            "dj.remove_source" -> {
                val sourceId = args.optString("source_id").takeIf { it.isNotBlank() } ?: invalid()
                val current = djPlanner.sources
                val remaining = org.json.JSONArray((0 until current.length()).map { current.getJSONObject(it) }.filter { it.optString("id") != sourceId })
                if (remaining.length() == current.length()) throw RemoteCommandRejected("not_found")
                if (remaining.length() == 0) throw RemoteCommandRejected("invalid_state")
                djSettings(remaining, resetRequestGroups = false)
            }
            "dj.change_session" -> djSettings(org.json.JSONArray().put(djSource(1)), resetRequestGroups = true)
            "dj.repair" -> program("djRepair") {
                putString("programToken", ProgramQueue.programToken(player)); putString("queueToken", ProgramQueue.token(player))
            }
            "dj.set_mixing" -> { mixing.settings(on()) { ok -> done(if (ok) null else "invalid_state") }; return }
            "session.import" -> { importRemoteSession(args, done); return }
            "session.release" -> if (liveListener == null) player.pause()
            else -> throw RemoteCommandRejected("unsupported")
        }
        done(null)
    }

    private fun importRemoteSession(args: org.json.JSONObject, done: (String?) -> Unit) {
        val state = args.optJSONObject("state") ?: throw RemoteCommandRejected("invalid")
        val restored = ProgramDeviceState.restoreState(state) ?: throw RemoteCommandRejected("nothing_playing")
        if (restored.workspace != null) {
            val rows = ProgramDeviceState.djRows(connection, restored, djPlanner)
            val heard = restored.workspace.optJSONArray("heard") ?: org.json.JSONArray()
            val heardIds = (0 until minOf(15, heard.length())).mapNotNull { heard.optJSONObject(it)?.optString("id")?.takeIf { id -> id.isNotBlank() && id.length <= 512 } }.toSet()
            djPlanner.restoreWorkspace(restored.workspace)
            if (liveListener != null) restoreNormal()
            djRouteEditor?.clear(); djRefiner?.clear(); refillAnchor = ""
            installDj(rows, restored.positionMs, restored.index, heardIds)
            player.play(); publishDj("ready", 0)
        } else {
            val items = ProgramDeviceState.items(connection, restored)
            val continuation = restored.radio?.optBoolean("active") == true || items.any { it.mediaMetadata.extras?.getBoolean("autoplayGenerated") == true }
            if (continuation) require(items[restored.index].mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true)
            djRouteEditor?.clear(); djPlanner.clear(); restoreNormal(); publishDj("idle", 0)
            autoplay.clear(); radio.clear()
            player.shuffleModeEnabled = restored.shuffle; player.repeatMode = restored.repeat
            player.setMediaItems(items, restored.index, restored.positionMs)
            val entries = restored.entries
            fun generated(source: String) = items.indices.filter { i -> entries?.optJSONObject(i)?.let { it.optString("queueLane") == "generated" && it.optString("queueSource") == source } == true }
                .map { items[it].mediaMetadata.extras!!.getString(ProgramQueue.KEY)!! }.toSet()
            if (restored.radio?.optBoolean("active") == true) radio.restore(restored.radio, generated("radio"))
            else autoplay.restoreGenerated(generated("autoplay"))
            player.prepare(); player.play()
        }
        awaitImportPlaying(done)
    }

    /**
     * Only matcher 400/404 means a retained pending recording cannot be played.
     * Authentication, TLS and temporary failures keep the occurrence for Retry.
     */
    private fun unplayablePending(error: PlaybackException): Boolean {
        if (dj != null || player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.PENDING) == null) return false
        val status = generateSequence(error as Throwable) { it.cause }
            .filterIsInstance<androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode
        return status == 400 || status == 404
    }

    /** Transfer succeeds only once the target is actually playing, bounded well under the 10 s wire timeout. */
    private fun awaitImportPlaying(done: (String?) -> Unit) {
        pendingImport?.invoke(); pendingImport = null
        val epoch = connection.generation
        var settled = false
        lateinit var listener: Player.Listener
        lateinit var deadline: Runnable
        fun settle(reason: String?) {
            if (settled) return
            settled = true
            player.removeListener(listener); main.removeCallbacks(deadline); pendingImport = null
            done(reason)
        }
        fun check() {
            when {
                connection.generation != epoch -> settle("invalid_state")
                player.isPlaying -> settle(null)
                !player.playWhenReady -> settle("invalid_state")
                // The error listener skips an unplayable pending entry; wait for the next one.
                player.playerError?.let { unplayablePending(it) && player.nextMediaItemIndex != C.INDEX_UNSET && player.mediaItemCount > 1 } == false ->
                    settle("invalid_state")
            }
        }
        listener = object : Player.Listener { override fun onEvents(player: Player, events: Player.Events) = check() }
        deadline = Runnable { settle(if (player.isPlaying) null else "invalid_state") }
        pendingImport = { settle("invalid_state") }
        player.addListener(listener)
        main.postDelayed(deadline, 7500)
        check()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session
    override fun onDestroy() {
        pendingImport?.invoke(); pendingImport = null
        savePodcast()
        connection.resetListeners.remove(reset)
        liveHost.close()
        deviceSession.close()
        carSubscriptions.close()
        carArt.close()
        carLibrary.close()
        djRefiner?.close()
        djPlanner.close()
        djRouteEditor?.close()
        dj?.close(); dj = null
        liveListener?.release(); liveListener = null
        autoplay.close()
        leveling.close(); mixing.close()
        NativeProgramOutput.unbind(pcmTap)
        radio.close()
        previews.close()
        artwork.close()
        cancelAudio()
        session?.release(); session = null; player.release(); main.removeCallbacksAndMessages(null)
        retireTransport(); networkCleanup.shutdown()
        super.onDestroy()
    }
}
