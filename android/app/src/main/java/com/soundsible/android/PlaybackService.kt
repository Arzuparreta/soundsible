package com.soundsible.android

import android.app.PendingIntent
import android.content.Intent
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
    private lateinit var player: ExoPlayer
    private lateinit var connection: EngineConnection
    private lateinit var previews: PreviewProgram
    private lateinit var artwork: ProgramArtwork
    @Volatile private var transport: Pair<Long, OkHttpClient>? = null
    private val audioCalls = java.util.concurrent.ConcurrentHashMap<okhttp3.Call, String>()
    private fun cancelAudio(key: String? = null) { audioCalls.entries.filter { key == null || it.value == key }.forEach { it.key.cancel() } }
    private val main = Handler(Looper.getMainLooper())
    private val reset: () -> Unit = {
        cancelAudio()
        transport?.second?.dispatcher?.cancelAll(); transport = null
        main.post { if (session != null) closeProgram() }
    }
    /** On the player looper; does not touch account generation, cookie or library. */
    private fun closeProgram() {
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
    override fun onCreate() {
        super.onCreate()
        connection = EngineConnection.shared(this)
        artwork = ProgramArtwork(connection)
        val factory = androidx.media3.datasource.DataSource.Factory {
            // Each source pins the selected account; every HTTP request revalidates it.
            val epoch = connection.generation
            val selected = connection.origin
            val client = synchronized(this) { transport?.takeIf { it.first == epoch }?.second ?: connection.client.newBuilder().retryOnConnectionFailure(false).eventListener(object : okhttp3.EventListener() {
                override fun callStart(call: okhttp3.Call) { audioCalls[call] = call.request().url.queryParameter("android_occurrence") ?: "" }
                override fun callEnd(call: okhttp3.Call) { audioCalls.remove(call) }
                override fun callFailed(call: okhttp3.Call, ioe: java.io.IOException) { audioCalls.remove(call) }
            }).addInterceptor { chain ->
                if (epoch != connection.generation || selected != connection.origin || chain.request().url.queryParameter("android_generation") != epoch.toString()) throw java.io.IOException("STALE_SESSION")
                val cookie = connection.cookieHeader(epoch) ?: throw java.io.IOException("NO_SESSION")
                val response = chain.proceed(chain.request().newBuilder().url(chain.request().url.newBuilder().removeAllQueryParameters("android_generation").removeAllQueryParameters("android_occurrence").build()).header("Cookie", cookie).build())
                if (epoch != connection.generation) { response.close(); throw java.io.IOException("STALE_SESSION") }
                if (response.isSuccessful && ::previews.isInitialized) previews.loaded(chain.request().url.queryParameter("android_occurrence") ?: "")
                if (response.code == 401) main.post { if (epoch == connection.generation) player.pause() }
                response
            }.build()
                .also { transport = epoch to it }
            }
            OkHttpDataSource.Factory(client).createDataSource()
        }
        val localFactory = DefaultMediaSourceFactory(factory).setLoadErrorHandlingPolicy(object : androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(0) {
            override fun getRetryDelayMsFor(loadErrorInfo: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET
        })
        val sources = object : androidx.media3.exoplayer.source.MediaSource.Factory {
            override fun setDrmSessionManagerProvider(provider: androidx.media3.exoplayer.drm.DrmSessionManagerProvider) = apply { localFactory.setDrmSessionManagerProvider(provider) }
            override fun setLoadErrorHandlingPolicy(policy: androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy) = apply { localFactory.setLoadErrorHandlingPolicy(policy) }
            override fun getSupportedTypes() = localFactory.supportedTypes
            override fun createMediaSource(item: MediaItem): androidx.media3.exoplayer.source.MediaSource {
                val extras = item.mediaMetadata.extras
                return if (extras?.getString(ProgramQueue.SOURCE) == "preview")
                    androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(factory, PreviewExtractors()).setLoadErrorHandlingPolicy(
                        previews.policy(extras.getString(ProgramQueue.KEY) ?: "", connection.generation)).createMediaSource(item)
                else localFactory.createMediaSource(item)
            }
        }
        player = ExoPlayer.Builder(this).setMediaSourceFactory(sources)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build()
        previews = PreviewProgram(connection, player, main, { session }) { key -> cancelAudio(key) }
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                if (item?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) == "preview") artwork.clear()
                previews.sync()
            }
            override fun onEvents(player: Player, events: Player.Events) { previews.sync() }
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
                    if (args.getString("action") == "stop") {
                        require(args.getLong("generation", -1) == connection.generation && args.getString("queueToken") == ProgramQueue.token(player))
                        closeProgram()
                    } else ProgramQueue.edit(player, connection, args) { previews.manualRetry() }
                    SessionResult(SessionResult.RESULT_SUCCESS) } catch (_: Exception) { SessionResult(SessionError.ERROR_BAD_VALUE) })
            }
        }).setBitmapLoader(artwork).setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session
    override fun onDestroy() {
        connection.resetListeners.remove(reset)
        previews.close()
        artwork.close()
        cancelAudio()
        transport?.second?.dispatcher?.cancelAll(); transport = null
        session?.release(); session = null; player.release(); main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
