package com.soundsible.android

import android.content.ComponentName
import android.os.Bundle
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
    private var sequence = 0L
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
        val items = JSArray()
        if (p != null) for (i in 0 until p.mediaItemCount) {
            val item = p.getMediaItemAt(i)
            queue.put(item.mediaId)
            items.put(JSObject().put("key", ProgramQueue.key(p, i)).put("id", item.mediaId).put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "").put("album", item.mediaMetadata.albumTitle?.toString() ?: ""))
        }
        return JSObject().put("sequence", ++sequence).put("generation", EngineConnection.shared(context).generation)
            .put("items", items).put("queueToken", if (p != null) ProgramQueue.token(p) else "")
            .put("ready", p != null).put("playing", p?.isPlaying ?: false)
            .put("playWhenReady", p?.playWhenReady ?: false).put("errorKind", PlaybackRecovery.kind(p?.playerError))
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
                    val items = ProgramQueue.items(connection, rows)
                    val index = call.getInt("index") ?: 0
                    require(index in items.indices)
                    p.setMediaItems(items, index, 0); p.prepare(); p.play()
                }
                "select", "move", "remove", "append", "insertAfter", "retry" -> {
                    val args = Bundle().apply {
                        putLong("generation", connection.generation)
                        putString("action", call.getString("action")); putString("queueToken", call.getString("queueToken")); putString("key", call.getString("key"))
                        putString("tracks", call.getArray("tracks")?.toString())
                        putInt("index", call.getInt("index") ?: -1); putInt("toIndex", call.getInt("toIndex") ?: -1)
                    }
                    val result = p.sendCustomCommand(ProgramQueue.command, args)
                    result.addListener({
                        try {
                            require(alive && args.getLong("generation") == connection.generation && result.get().resultCode == androidx.media3.session.SessionResult.RESULT_SUCCESS)
                            call.resolve(snapshot())
                        } catch (_: Exception) { call.reject("Queue changed or session unavailable", "PLAYBACK_COMMAND") }
                    }, java.util.concurrent.Executor { task -> main.post(task) })
                    return@post
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
