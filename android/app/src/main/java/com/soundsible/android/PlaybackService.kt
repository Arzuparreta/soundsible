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
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService
import okhttp3.OkHttpClient

/** One program, independent of the Activity. Queue survives Activity recreation, not process death. */
@UnstableApi
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null
    private lateinit var player: ExoPlayer
    private lateinit var connection: EngineConnection
    @Volatile private var transport: Pair<Long, OkHttpClient>? = null
    private val main = Handler(Looper.getMainLooper())
    private val reset: () -> Unit = {
        transport?.second?.dispatcher?.cancelAll(); transport = null
        main.post { if (session != null) { player.stop(); player.clearMediaItems(); player.shuffleModeEnabled = false; player.repeatMode = Player.REPEAT_MODE_OFF } }
    }
    override fun onCreate() {
        super.onCreate()
        connection = EngineConnection.shared(this)
        val factory = androidx.media3.datasource.DataSource.Factory {
            // Each source pins the selected account; every HTTP request revalidates it.
            val epoch = connection.generation
            val selected = connection.origin
            val client = synchronized(this) { transport?.takeIf { it.first == epoch }?.second ?: connection.client.newBuilder().addInterceptor { chain ->
                if (epoch != connection.generation || selected != connection.origin || chain.request().url.queryParameter("android_generation") != epoch.toString()) throw java.io.IOException("STALE_SESSION")
                val cookie = connection.cookieHeader(epoch) ?: throw java.io.IOException("NO_SESSION")
                val response = chain.proceed(chain.request().newBuilder().url(chain.request().url.newBuilder().removeAllQueryParameters("android_generation").build()).header("Cookie", cookie).build())
                if (epoch != connection.generation) { response.close(); throw java.io.IOException("STALE_SESSION") }
                if (response.code == 401) main.post { if (epoch == connection.generation) player.pause() }
                response
            }.build()
                .also { transport = epoch to it }
            }
            OkHttpDataSource.Factory(client).createDataSource()
        }
        player = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(factory))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build()
        connection.resetListeners.add(reset)
        session = MediaLibrarySession.Builder(this, player, object : MediaLibrarySession.Callback {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                // Same app owns queue replacement. Trusted OS controllers can control its current program.
                if (controller.uid != android.os.Process.myUid() && !controller.isTrusted) return MediaSession.ConnectionResult.reject()
                val commands = Player.Commands.Builder().addAllCommands()
                if (controller.uid != android.os.Process.myUid()) commands.remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).remove(Player.COMMAND_SET_MEDIA_ITEM)
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailablePlayerCommands(commands.build()).build()
            }
        }).setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session
    override fun onDestroy() {
        connection.resetListeners.remove(reset)
        transport?.second?.dispatcher?.cancelAll(); transport = null
        session?.release(); session = null; player.release(); main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
