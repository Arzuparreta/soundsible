package com.soundsible.android

import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture

@UnstableApi
@CapacitorPlugin(name = "SoundsiblePlayback")
class PlaybackPlugin : Plugin() {
    private var alive = true
    private var visible = true
    private var controller: MediaController? = null
    private var pending: ListenableFuture<MediaController>? = null
    private val main = Handler(Looper.getMainLooper())
    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { publish() }
    }
    private val ticker = object : Runnable { override fun run() { if (alive && visible) { publish(); main.postDelayed(this, 500) } } }
    override fun load() {
        pending = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync().also { future ->
            future.addListener({ try { if (alive) { controller = future.get(); controller?.addListener(listener); if (visible) main.post(ticker) } } catch (_: Exception) {} }, java.util.concurrent.Executor { task -> main.post(task) })
        }
    }
    private fun snapshot(): JSObject {
        val p = controller
        val queue = JSArray()
        if (p != null) for (i in 0 until p.mediaItemCount) queue.put(p.getMediaItemAt(i).mediaId)
        return JSObject().put("generation", EngineConnection.shared(context).generation)
            .put("ready", p != null).put("playing", p?.isPlaying ?: false)
            .put("shuffle", p?.shuffleModeEnabled ?: false).put("repeat", p?.repeatMode ?: Player.REPEAT_MODE_OFF)
            .put("hasNext", p?.hasNextMediaItem() ?: false).put("hasPrevious", p?.hasPreviousMediaItem() ?: false)
            .put("state", p?.playbackState ?: Player.STATE_IDLE).put("index", p?.currentMediaItemIndex ?: -1)
            .put("id", p?.currentMediaItem?.mediaId ?: "").put("queue", queue)
            .put("title", p?.mediaMetadata?.title?.toString() ?: "").put("artist", p?.mediaMetadata?.artist?.toString() ?: "")
            .put("positionMs", p?.currentPosition ?: 0).put("durationMs", p?.duration?.coerceAtLeast(0) ?: 0)
            .put("error", p?.playerError?.errorCode ?: 0)
            .put("errorStatus", generateSequence(p?.playerError as Throwable?) { it.cause }.filterIsInstance<androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode ?: 0)
    }
    private fun publish() { if (alive && visible) notifyListeners("playbackState", snapshot()) }
    override fun handleOnPause() { visible = false; main.removeCallbacks(ticker) }
    override fun handleOnResume() { visible = true; main.removeCallbacks(ticker); if (controller != null) main.post(ticker) }
    @PluginMethod fun state(call: PluginCall) { main.post { call.resolve(snapshot()) } }
    @PluginMethod fun command(call: PluginCall) { main.post {
        try {
            val connection = EngineConnection.shared(context)
            require((call.getInt("generation")?.toLong() ?: -1L) == connection.generation)
            val p = controller ?: error("NOT_READY")
            when (call.getString("action")) {
                "queue" -> {
                    require(p.isCommandAvailable(Player.COMMAND_CHANGE_MEDIA_ITEMS) && p.isCommandAvailable(Player.COMMAND_PLAY_PAUSE))
                    require(connection.cookieHeader(connection.generation) != null)
                    val rows = call.getArray("tracks") ?: error("NO_TRACKS")
                    require(rows.length() in 1..1000)
                    val items = (0 until rows.length()).map { i ->
                        val row = rows.getJSONObject(i)
                        val id = row.getString("id")
                        require(id.isNotBlank() && id.length <= 512)
                        MediaItem.Builder().setMediaId(id).setUri(connection.origin + "/api/static/stream/" + android.net.Uri.encode(id) + "?android_generation=" + connection.generation)
                            .setMediaMetadata(MediaMetadata.Builder().setTitle(row.optString("title")).setArtist(row.optString("artist")).setAlbumTitle(row.optString("album")).build()).build()
                    }
                    val index = call.getInt("index") ?: 0
                    require(index in items.indices)
                    p.setMediaItems(items, index, 0); p.prepare(); p.play()
                }
                "play" -> { if (p.playerError != null || p.playbackState == Player.STATE_ENDED) { p.seekTo(p.currentMediaItemIndex, if (p.playbackState == Player.STATE_ENDED) 0 else p.currentPosition); p.prepare() }; p.play() }
                "pause" -> p.pause()
                "seek" -> p.seekTo((call.getDouble("positionMs") ?: 0.0).toLong().coerceAtLeast(0))
                "shuffle" -> {
                    require(p.isCommandAvailable(Player.COMMAND_SET_SHUFFLE_MODE))
                    p.shuffleModeEnabled = call.getBoolean("enabled") ?: error("NO_SHUFFLE_MODE")
                }
                "repeat" -> {
                    require(p.isCommandAvailable(Player.COMMAND_SET_REPEAT_MODE))
                    val mode = call.getInt("mode") ?: error("NO_REPEAT_MODE")
                    require(mode in Player.REPEAT_MODE_OFF..Player.REPEAT_MODE_ALL)
                    p.repeatMode = mode
                }
                "next" -> p.seekToNextMediaItem()
                "previous" -> p.seekToPreviousMediaItem()
                "stop" -> { p.stop(); p.clearMediaItems() }
                else -> error("INVALID_COMMAND")
            }
            call.resolve(snapshot())
        } catch (_: Exception) { call.reject("Playback unavailable or session changed", "PLAYBACK_COMMAND") }
    } }
    override fun handleOnDestroy() {
        alive = false; main.removeCallbacksAndMessages(null); controller?.removeListener(listener)
        pending?.let { MediaController.releaseFuture(it) }; controller = null
    }
}
