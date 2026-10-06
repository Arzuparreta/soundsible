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

/** One program, independent of the Activity. Queue survives Activity recreation, not process death. */
@UnstableApi
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private lateinit var player: ProgramPlayerRouter
    private lateinit var normalFactory: () -> ExoPlayer
    private lateinit var djPlanner: ProgramDjPlanner
    private var dj: ProgramDjSession? = null
    private var djRouteEditor: ProgramDjRouteEditor? = null
    private var djPhase = "idle"
    private var djProfile = "adaptive"
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
        pendingCarRadio = null
        djRefiner?.clear()
        djRouteEditor?.clear()
        djPlanner.clear(); refillAnchor = ""
        restoreNormal()
        publishDj("idle", djProfile, 0)
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
    private fun orgJson(value: String) = org.json.JSONObject(value)
    private fun publishDj(phase: String, profile: String, code: Int) {
        djPhase = phase; djProfile = profile; djError = code
        session?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putLong("djGeneration", connection.generation); putBoolean("djActive", dj != null)
            putString("djPhase", phase); putString("djProfile", profile); putInt("djErrorStatus", code)
            putLong("djEditRevision", djRouteEditor?.revision ?: 0)
            putInt("djEditableFrom", dj?.editableFrom() ?: 0)
            putString("djProtectedKeys", org.json.JSONArray(dj?.protectedKeys()?.toList() ?: emptyList<String>()).toString())
            putString("djEditOutcome", djRouteEditor?.outcome ?: "idle")
            putString("djRequestTitle", djRouteEditor?.requestTitle ?: "")
            putString("djDirection", djPlanner.direction.toString()); putString("djSources", djPlanner.sources.toString())
        }) }
    }
    private fun maybeRefill() {
        val owner = dj ?: return
        if (djPlanner.busy() || djRouteEditor?.busy() == true || !player.playWhenReady || owner.items().size - owner.currentIndex() - 1 > 3) return
        val anchor = owner.items().lastOrNull() ?: return
        val key = anchor.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: return
        val marker = key + ":" + ProgramQueue.token(player)
        if (refillAnchor == marker) return
        refillAnchor = marker
        djPlanner.start(djPlanner.profile, djPlanner.direction, djPlanner.sources, true, ProgramDjPlanner.Kind.APPEND, anchor)
    }
    private fun restoreNormal() {
        djRefiner?.clear()
        val previous = dj ?: return
        player.pause(); player.stop()
        val normal = normalFactory().apply { volume = player.volume }
        player.replaceBackend(normal)
        previous.close(); dj = null
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
            val client = synchronized(this) { transport?.takeIf { it.first == epoch }?.second ?: connection.client.newBuilder()
                .dispatcher(okhttp3.Dispatcher()).connectionPool(okhttp3.ConnectionPool())
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
                    // failed pooled socket; a new exchange rechecks the account.
                    val connected = connectedCalls.contains(chain.call())
                    if (BuildConfig.DEBUG) android.util.Log.d("AudioConnection", "Headers failed; connected=$connected cancelled=${chain.call().isCanceled()}")
                    if (request.method != "GET" || !AudioConnectionRepair.allowed(failure, connected, false, chain.call().isCanceled()) || epoch != connection.generation || selected != connection.origin) throw failure
                    chain.proceed(request)
                }
                if (epoch != connection.generation) { response.close(); throw java.io.IOException("STALE_SESSION") }
                if (response.isSuccessful && ::previews.isInitialized) previews.loaded(chain.request().url.queryParameter("android_occurrence") ?: "")
                if (response.code == 401) main.post { if (epoch == connection.generation) player.pause() }
                response
            }.build()
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
        leveling = ProgramAudioPreference(this, connection, main, "volume_leveling", "leveling") { session }
        mixing = ProgramAudioPreference(this, connection, main, "dj_mixing", "mixing") { session }
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
        radio = RadioProgram(connection, player, main, session = { session })
        autoplay = AutoplayProgram(connection, player, main, { session }, { radio.active() || dj != null })
        djPlanner = ProgramDjPlanner(connection, player, main, { dj?.heardIds() ?: emptySet() }, ::publishDj) { rows, position, kind ->
            if (kind != ProgramDjPlanner.Kind.START) {
                dj?.let { owner ->
                    if (kind == ProgramDjPlanner.Kind.APPEND) owner.append(rows.drop(1)) else { owner.replaceFuture(rows); refillAnchor = "" }
                    publishDj(djPhase, djProfile, djError)
                }
            } else {
            val epoch = connection.generation
            val identity = connection.sessionIdentity(epoch)
            val next = ProgramDjSession(this, epoch, { epoch == connection.generation && runCatching { connection.sessionIdentity(epoch) }.getOrNull() == identity },
                sources, pcmTap, leveling::active, rows, position, mixing = mixing::active, refine = { djRefiner?.refine(it) }, changed = { publishDj(djPhase, djProfile, djError) })
            autoplay.clear(); radio.clear()
            val resume = player.playWhenReady || rows.firstOrNull()?.kind != "user"
            val previousDj = dj; dj = next
            player.pause(); player.stop()
            val volume = player.volume
            val previous = player.replaceBackend(next.player)
            if (previousDj != null) previousDj.close() else previous.release()
            next.player.volume = volume
            if (resume) next.player.play()
            publishDj(djPhase, djProfile, djError); refillAnchor = ""
            }
        }
        djRefiner = ProgramDjRefiner(connection, main, { dj }, djPlanner)
        djRouteEditor = ProgramDjRouteEditor(connection, main, { dj }, djPlanner) { phase, code -> publishDj(phase, djPlanner.profile, code) }
        player.addListener(object : Player.Listener {
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
        liveHost = NativeLiveHost(this, connection, main, { player }) { state ->
            session?.let { active -> active.setSessionExtras(Bundle(active.sessionExtras).apply { putString("nativeLiveHost", state.toString()) }) }
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
                    djRouteEditor?.clear(); djRefiner?.clear(); djPlanner.clear(); refillAnchor = ""
                    restoreNormal(); publishDj("idle", djProfile, 0)
                    autoplay.clear(); radio.clear(); previews.clear()
                    pendingCarRadio = if (selected.radio) selected.items.single().mediaMetadata.extras!!.getString(ProgramQueue.KEY) else null
                    val index = if (startIndex == C.INDEX_UNSET) 0 else startIndex
                    val position = if (startPositionMs == C.TIME_UNSET) podcasts.position(selected.items[index]) else startPositionMs.coerceAtLeast(0)
                    Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(selected.items, index, position))
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
                if (args.getString("action") in listOf("liveStart", "liveStop", "liveTitle", "liveChat")) {
                    if (args.getLong("generation", -1) != connection.generation) return Futures.immediateFuture(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                    return when (args.getString("action")) {
                        "liveStart" -> liveHost.start(args.getString("title").orEmpty())
                        "liveTitle" -> liveHost.title(args.getString("title").orEmpty())
                        "liveChat" -> liveHost.chat(args.getString("text").orEmpty())
                        else -> liveHost.stop()
                    }
                }
                return Futures.immediateFuture(try {
                    if (args.getString("action") == "djContext") {
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
                            djPlanner.start(djPlanner.profile, djPlanner.direction, org.json.JSONArray().put(source), true, ProgramDjPlanner.Kind.REPLACE)
                        } else {
                            djPlanner.start(djPlanner.profile, djPlanner.direction, org.json.JSONArray().put(source), player.mediaItemCount > 0,
                                lead = track.takeIf { player.mediaItemCount > 0 })
                        }
                    } else if (args.getString("action") == "djRequest") {
                        require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player) && args.getString("queueToken") == ProgramQueue.token(player))
                        val rows = org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACK")); require(rows.length() == 1)
                        val track = ProgramQueue.items(connection, rows, ProgramQueue.programToken(player)).single()
                        require(track.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true)
                        djPlanner.clear(); refillAnchor = ""
                        djRouteEditor!!.place(track, args.getString("beforeKey")?.takeIf { it.isNotBlank() })
                    } else if (args.getString("action") == "djRepair") {
                        require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player) && args.getString("queueToken") == ProgramQueue.token(player))
                        djPlanner.clear(); refillAnchor = ""
                        djRouteEditor!!.repair()
                    } else if (args.getString("action") == "djSettings") {
                        require(dj != null && args.getLong("generation", -1) == connection.generation && args.getString("programToken") == ProgramQueue.programToken(player))
                        refillAnchor = ""
                        djRouteEditor?.clear()
                        djPlanner.start(args.getString("profile") ?: djPlanner.profile,
                            args.getString("direction")?.let(::orgJson) ?: djPlanner.direction,
                            args.getString("sources")?.let { org.json.JSONArray(it) } ?: djPlanner.sources,
                            true, ProgramDjPlanner.Kind.REPLACE)
                    } else if (args.getString("action") == "dj") {
                        require(args.getLong("generation", -1) == connection.generation)
                        if (args.getBoolean("fromCurrent", true)) require(args.getString("queueToken") == ProgramQueue.token(player) && args.getString("key") == ProgramQueue.key(player, player.currentMediaItemIndex))
                        djRouteEditor?.clear()
                        djPlanner.start(args.getString("profile") ?: "adaptive",
                            org.json.JSONObject(args.getString("direction") ?: "{\"energy\":0,\"familiarity\":0,\"prompt\":\"\",\"include\":[],\"exclude\":[]}"),
                            org.json.JSONArray(args.getString("sources") ?: "[]"), args.getBoolean("fromCurrent", true))
                    } else if (args.getString("action") == "queue") {
                        require(args.getLong("generation", -1) == connection.generation)
                        val items = ProgramQueue.items(connection, org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACKS")), contextKind = args.getString("contextKind"), contextId = args.getString("contextId"))
                        val index = args.getInt("index", -1); require(index in items.indices)
                        djRouteEditor?.clear(); djPlanner.clear(); restoreNormal(); publishDj("idle", djProfile, 0)
                        autoplay.clear()
                        radio.clear()
                        player.shuffleModeEnabled = args.getBoolean("shuffle")
                        player.setMediaItems(items, index, podcasts.position(items[index])); player.prepare(); player.play()
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
                            if (dj != null) {
                                val seed = player.currentMediaItem ?: error("NO_SEED")
                                val position = player.currentPosition
                                val requested = player.playWhenReady
                                djRouteEditor?.clear(); djPlanner.clear(); refillAnchor = ""
                                restoreNormal(); publishDj("idle", djProfile, 0)
                                player.setMediaItem(seed, position); player.prepare()
                                if (requested) player.play()
                            }
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
                    SessionResult(SessionResult.RESULT_SUCCESS) } catch (failure: Exception) {
                        if (BuildConfig.DEBUG) android.util.Log.w("ProgrammeCommand", "${args.getString("action")}:${failure.javaClass.simpleName}:${failure.stackTrace.firstOrNull { it.className.startsWith("com.soundsible.android") }}")
                        SessionResult(SessionError.ERROR_BAD_VALUE)
                    })
            }
        }).setBitmapLoader(artwork).setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        main.post(progressTicker)
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session
    override fun onDestroy() {
        savePodcast()
        connection.resetListeners.remove(reset)
        liveHost.close()
        carSubscriptions.close()
        carArt.close()
        carLibrary.close()
        djRefiner?.close()
        djPlanner.close()
        djRouteEditor?.close()
        dj?.close(); dj = null
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
