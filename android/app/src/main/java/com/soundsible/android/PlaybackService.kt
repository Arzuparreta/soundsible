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
    private var djPhase = "idle"
    private var djProfile = "adaptive"
    private var djError = 0
    private lateinit var connection: EngineConnection
    private lateinit var leveling: ProgramLeveling
    private val pcmTap = ProgramPcmTap()
    private lateinit var previews: PreviewProgram
    private lateinit var radio: RadioProgram
    private lateinit var autoplay: AutoplayProgram
    private lateinit var podcasts: PodcastProgressStore
    private val progressTicker = object : Runnable { override fun run() { if (session != null) { savePodcast(); main.postDelayed(this, 5000) } } }
    private fun savePodcast() { if (::player.isInitialized && ::podcasts.isInitialized) podcasts.save(player.currentMediaItem, player.currentPosition, player.duration, player.playbackState == Player.STATE_ENDED) }
    private lateinit var artwork: ProgramArtwork
    @Volatile private var transport: Pair<Long, OkHttpClient>? = null
    private val audioCalls = java.util.concurrent.ConcurrentHashMap<okhttp3.Call, String>()
    private val podcastSources = java.util.concurrent.ConcurrentHashMap<PodcastDataSource, String>()
    private val connectedCalls = java.util.concurrent.ConcurrentHashMap.newKeySet<okhttp3.Call>()
    private fun cancelAudio(key: String? = null) { podcastSources.entries.filter { key == null || it.value == key }.forEach { it.key.cancel() }; audioCalls.entries.filter { key == null || it.value == key }.forEach { it.key.cancel() } }
    private val main = Handler(Looper.getMainLooper())
    private val reset: () -> Unit = {
        cancelAudio()
        transport?.second?.dispatcher?.cancelAll(); transport = null
        main.post { if (session != null) closeProgram() }
    }
    /** On the player looper; does not touch account generation, cookie or library. */
    private fun closeProgram() {
        djPlanner.clear()
        restoreNormal()
        publishDj("idle", djProfile, 0)
        savePodcast()
        autoplay.clear()
        leveling.clear()
        radio.clear()
        previews.clear()
        player.pause(); player.stop(); player.clearMediaItems()
        // stop retains a previous playback error. Preparing an empty timeline clears it without a source.
        if (player.playerError != null) { player.prepare(); player.stop() }
        player.shuffleModeEnabled = false; player.repeatMode = Player.REPEAT_MODE_OFF
        artwork.clear()
        cancelAudio()
        transport?.second?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll() }; transport = null
        // Media3 removes the notification/foreground when its timeline is empty.
        triggerNotificationUpdate()
    }
    private fun publishDj(phase: String, profile: String, code: Int) {
        djPhase = phase; djProfile = profile; djError = code
        session?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putLong("djGeneration", connection.generation); putBoolean("djActive", dj != null)
            putString("djPhase", phase); putString("djProfile", profile); putInt("djErrorStatus", code)
        }) }
    }
    private fun restoreNormal() {
        val previous = dj ?: return
        player.pause(); player.stop()
        player.replaceBackend(normalFactory())
        previous.close(); dj = null
    }
    private fun retireSource(args: Bundle) {
        require(args.getLong("generation", -1) == connection.generation)
        val id = args.getString("id") ?: error("NO_SOURCE")
        val rows = (0 until player.mediaItemCount).map { index ->
            val item = player.getMediaItemAt(index)
            SourceRetirement.Reference(item.mediaId, item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) ?: "")
        }
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
            val client = synchronized(this) { transport?.takeIf { it.first == epoch }?.second ?: connection.client.newBuilder().retryOnConnectionFailure(false).eventListener(object : okhttp3.EventListener() {
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
        leveling = ProgramLeveling(this, connection, main) { session }
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
        djPlanner = ProgramDjPlanner(connection, player, main, ::publishDj) { rows, position ->
            val epoch = connection.generation
            val identity = connection.sessionIdentity(epoch)
            val next = ProgramDjSession(this, epoch, { epoch == connection.generation && runCatching { connection.sessionIdentity(epoch) }.getOrNull() == identity },
                sources, pcmTap, leveling::active, rows, position, changed = { publishDj(djPhase, djProfile, djError) })
            autoplay.clear(); radio.clear()
            val previousDj = dj; dj = next
            player.pause(); player.stop()
            val previous = player.replaceBackend(next.player)
            if (previousDj != null) previousDj.close() else previous.release()
            next.player.play(); publishDj(djPhase, djProfile, djError)
        }
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
            override fun onEvents(player: Player, events: Player.Events) { previews.sync(); radio.sync(); autoplay.sync(); leveling.sync(player.mediaItemCount > 0); savePodcast()
                val keys = (0 until player.mediaItemCount).map { ProgramQueue.key(player, it) }.toSet()
                podcastSources.entries.filter { it.value !in keys }.forEach { it.key.cancel() }
            }
        })
        connection.resetListeners.add(reset)
        session = MediaLibrarySession.Builder(this, player, object : MediaLibrarySession.Callback {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                // Same app owns queue replacement. Trusted OS controllers can control its current program.
                if (controller.uid != android.os.Process.myUid() && !controller.isTrusted) return MediaSession.ConnectionResult.reject()
                val commands = Player.Commands.Builder().addAllCommands()
                if (controller.uid != android.os.Process.myUid()) commands.remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).remove(Player.COMMAND_SET_MEDIA_ITEM)
                val sessions = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                if (controller.uid == android.os.Process.myUid()) sessions.add(ProgramQueue.command)
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller).setSessionExtras(session.sessionExtras).setAvailablePlayerCommands(commands.build()).setAvailableSessionCommands(sessions.build()).build()
            }
            override fun onPlayerCommandRequest(session: MediaSession, controller: MediaSession.ControllerInfo, command: Int): Int {
                val recovers = command == Player.COMMAND_PREPARE || command == Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM || command == Player.COMMAND_SEEK_TO_DEFAULT_POSITION || command == Player.COMMAND_SEEK_TO_MEDIA_ITEM || (command == Player.COMMAND_PLAY_PAUSE && !player.playWhenReady)
                if (recovers && player.playerError != null && !previews.canPrepare()) return SessionError.ERROR_BAD_VALUE
                if (command == Player.COMMAND_PREPARE && player.playerError != null) previews.manualRetry()
                return SessionResult.RESULT_SUCCESS
            }
            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (customCommand.customAction != ProgramQueue.command.customAction || controller.uid != android.os.Process.myUid()) return Futures.immediateFuture(SessionResult(SessionError.ERROR_PERMISSION_DENIED))
                return Futures.immediateFuture(try {
                    if (args.getString("action") == "dj") {
                        require(args.getLong("generation", -1) == connection.generation)
                        if (args.getBoolean("fromCurrent", true)) require(args.getString("queueToken") == ProgramQueue.token(player) && args.getString("key") == ProgramQueue.key(player, player.currentMediaItemIndex))
                        djPlanner.start(args.getString("profile") ?: "adaptive",
                            org.json.JSONObject(args.getString("direction") ?: "{\"energy\":0,\"familiarity\":0,\"prompt\":\"\",\"include\":[],\"exclude\":[]}"),
                            org.json.JSONArray(args.getString("sources") ?: "[]"), args.getBoolean("fromCurrent", true))
                    } else if (args.getString("action") == "queue") {
                        require(args.getLong("generation", -1) == connection.generation)
                        val items = ProgramQueue.items(connection, org.json.JSONArray(args.getString("tracks") ?: error("NO_TRACKS")), contextKind = args.getString("contextKind"), contextId = args.getString("contextId"))
                        val index = args.getInt("index", -1); require(index in items.indices)
                        djPlanner.clear(); restoreNormal(); publishDj("idle", djProfile, 0)
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
                    } else if (args.getString("action") == "leveling") {
                        require(args.getLong("generation", -1) == connection.generation)
                        leveling.settings(if (args.getBoolean("reload")) null else args.getBoolean("enabled"))
                    } else if (args.getString("action") == "radio") {
                        require(args.getLong("generation", -1) == connection.generation && args.getString("queueToken") == ProgramQueue.token(player))
                        args.getString("key")?.let { require(it == ProgramQueue.key(player, player.currentMediaItemIndex)) }
                        if (args.getBoolean("enabled")) { autoplay.suspend(); radio.start(args.getString("profile") ?: "balanced") } else { radio.stop(); autoplay.sync() }
                    } else if (args.getString("action") == "stop") {
                        require(args.getLong("generation", -1) == connection.generation)
                        // Refills retain the program identity; replacement starts another.
                        // Keep the older order-based contract for callers without that identity.
                        val owner = args.getString("programToken")
                        if (owner != null) require(owner.isNotBlank() && owner == ProgramQueue.programToken(player))
                        else require(args.getString("queueToken") == ProgramQueue.token(player))
                        closeProgram()
                    } else ProgramQueue.edit(player, connection, args, { previews.manualRetry() }, podcasts::position, (radio.manualInsertion() ?: autoplay.manualInsertion()))
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
        djPlanner.close()
        dj?.close(); dj = null
        autoplay.close()
        leveling.close()
        NativeProgramOutput.unbind(pcmTap)
        radio.close()
        previews.close()
        artwork.close()
        cancelAudio()
        transport?.second?.dispatcher?.cancelAll(); transport = null
        session?.release(); session = null; player.release(); main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
