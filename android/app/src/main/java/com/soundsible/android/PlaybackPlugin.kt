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
    private val liveRequests = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val liveWorker = java.util.concurrent.ThreadPoolExecutor(1, 1, 0, java.util.concurrent.TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(2))
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
        pending = MediaController.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).setListener(object : MediaController.Listener { override fun onExtrasChanged(controller: MediaController, extras: Bundle) { publish() } }).buildAsync().also { future ->
            future.addListener({ try { if (alive) { controller = future.get(); controller?.addListener(listener); if (visible) main.post(ticker) } } catch (_: Exception) {} }, java.util.concurrent.Executor { task -> main.post(task) })
        }
    }
    private fun snapshot(): JSObject {
        val p = controller
        val hasItems = p != null && p.mediaItemCount > 0
        val queue = JSArray()
        val items = JSArray()
        if (p != null) for (i in 0 until p.mediaItemCount) {
            val item = p.getMediaItemAt(i)
            queue.put(item.mediaId)
            items.put(JSObject().put("pendingResolve", item.mediaMetadata.extras?.getString(ProgramQueue.PENDING)?.let { JSObject(it) }).put("routeOwnerKey", item.mediaMetadata.extras?.getString(ProgramQueue.BRIDGE_OWNER)).put("generated", (item.mediaMetadata.extras?.getBoolean("radioGenerated") == true || item.mediaMetadata.extras?.getBoolean("autoplayGenerated") == true)).put("generatedSource", if (item.mediaMetadata.extras?.getBoolean("autoplayGenerated") == true) "autoplay" else if (item.mediaMetadata.extras?.getBoolean("radioGenerated") == true) "radio" else null).put("offline", item.mediaMetadata.extras?.getBoolean("offline") ?: false).put("mediaKind", if (item.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true) "podcast_episode" else null).put("source", item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE)).put("key", ProgramQueue.key(p, i)).put("id", item.mediaId).put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "").put("album", item.mediaMetadata.albumTitle?.toString() ?: ""))
        }
        val extras = p?.sessionExtras
        val preview = if (hasItems && extras?.getString("previewKey") == ProgramQueue.key(p!!, p.currentMediaItemIndex) && extras.getLong("previewGeneration") == EngineConnection.shared(context).generation) {
            JSObject().put("key", extras.getString("previewKey"))
                .put("preparation", extras.getString("previewPreparation")?.let { JSObject(it) })
                .put("retryAttempt", extras.getInt("previewRetryAttempt"))
                .put("retryPending", extras.getBoolean("previewRetryPending"))
                .put("retryNotBeforeMs", extras.getLong("previewRetryNotBefore"))
        } else null
        val radioError = if (extras?.getLong("radioGeneration") == EngineConnection.shared(context).generation) extras.getInt("radioErrorStatus") else 0
        val autoplayError = if (extras?.getLong("autoplayGeneration") == EngineConnection.shared(context).generation) extras.getInt("autoplayErrorStatus") else 0
        val djError = if (extras?.getLong("djGeneration") == EngineConnection.shared(context).generation) extras.getInt("djErrorStatus") else 0
        val plannerError = if (djError != 0) djError else if (radioError != 0) radioError else autoplayError
        val authFailure = (preview != null && extras?.getBoolean("previewAuthFailure") == true) || plannerError == 401
        val radio = if (extras?.getLong("radioGeneration") == EngineConnection.shared(context).generation) JSObject().put("active", extras.getBoolean("radioActive")).put("phase", extras.getString("radioPhase")).put("profile", extras.getString("radioProfile")) else null
        val autoplay = if (extras?.getLong("autoplayGeneration") == EngineConnection.shared(context).generation) JSObject().put("enabled", if (extras.getBoolean("autoplayKnown")) extras.getBoolean("autoplayEnabled") else null).put("settingsPhase", extras.getString("autoplaySettingsPhase")).put("active", extras.getBoolean("autoplayActive")).put("phase", extras.getString("autoplayPhase")) else null
        val leveling = if (extras?.getLong("levelingGeneration") == EngineConnection.shared(context).generation) JSObject().put("enabled", if (extras.getBoolean("levelingKnown")) extras.getBoolean("levelingEnabled") else null).put("settingsPhase", extras.getString("levelingSettingsPhase")) else null
        val mixing = if (extras?.getLong("mixingGeneration") == EngineConnection.shared(context).generation) JSObject().put("enabled", if (extras.getBoolean("mixingKnown")) extras.getBoolean("mixingEnabled") else null).put("settingsPhase", extras.getString("mixingSettingsPhase")) else null
        val dj = if (extras?.getLong("djGeneration") == EngineConnection.shared(context).generation) JSObject().put("active", extras.getBoolean("djActive")).put("phase", extras.getString("djPhase")).put("profile", extras.getString("djProfile")).put("editRevision", extras.getLong("djEditRevision")).put("editableFrom", extras.getInt("djEditableFrom")).put("protectedKeys", extras.getString("djProtectedKeys")?.let { JSArray(it) }).put("editOutcome", extras.getString("djEditOutcome")).put("requestTitle", extras.getString("djRequestTitle")).put("direction", extras.getString("djDirection")?.let { JSObject(it) }).put("sources", extras.getString("djSources")?.let { JSArray(it) }) else null
        return JSObject().put("dj", dj).put("leveling", leveling).put("mixing", mixing).put("autoplay", autoplay).put("radio", radio).put("preview", preview).put("sequence", ++sequence).put("generation", EngineConnection.shared(context).generation)
            .put("items", items).put("queueToken", if (p != null) ProgramQueue.token(p) else "").put("programToken", if (p != null) ProgramQueue.programToken(p) else "")
            .put("ready", p != null).put("playing", p?.isPlaying ?: false)
            .put("playWhenReady", p?.playWhenReady ?: false).put("errorKind", if (authFailure) "auth" else if (plannerError == 403) "permission" else PlaybackRecovery.kind(p?.playerError))
            .put("shuffle", p?.shuffleModeEnabled ?: false).put("repeat", p?.repeatMode ?: Player.REPEAT_MODE_OFF)
            .put("hasNext", p?.hasNextMediaItem() ?: false).put("hasPrevious", p?.hasPreviousMediaItem() ?: false)
            .put("state", p?.playbackState ?: Player.STATE_IDLE).put("index", if (hasItems) p!!.currentMediaItemIndex else -1)
            .put("id", p?.currentMediaItem?.mediaId ?: "").put("queue", queue)
            .put("title", if (hasItems) p!!.mediaMetadata.title?.toString() ?: "" else "").put("artist", if (hasItems) p!!.mediaMetadata.artist?.toString() ?: "" else "")
            .put("seekable", hasItems && p!!.isCurrentMediaItemSeekable).put("positionMs", if (hasItems) p!!.currentPosition else 0).put("durationMs", if (hasItems) p!!.duration.coerceAtLeast(0) else 0)
            .put("error", p?.playerError?.errorCode ?: 0)
            .put("errorStatus", if (authFailure) 401 else if (plannerError == 403) 403 else generateSequence(p?.playerError as Throwable?) { it.cause }.filterIsInstance<androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException>().firstOrNull()?.responseCode ?: 0)
    }
    private fun liveSnapshot(): JSObject {
        val generation = EngineConnection.shared(context).generation
        fun scoped(key: String): JSObject? = controller?.sessionExtras?.getString(key)?.let { value ->
            runCatching { JSObject(value).takeIf { it.optLong("generation", -1) == generation } }.getOrNull()
        }
        return JSObject().put("generation", generation).put("ready", controller != null)
            .put("host", scoped("nativeLiveHost")).put("listener", scoped("nativeLiveListener"))
    }
    private fun deviceSnapshot(): JSObject {
        val generation = EngineConnection.shared(context).generation
        val state = controller?.sessionExtras?.getString("nativeDevice")?.let {
            runCatching { JSObject(it).takeIf { value -> value.optLong("generation", -1) == generation } }.getOrNull()
        }
        return state ?: JSObject().put("generation", generation).put("device_id", org.json.JSONObject.NULL).put("connected", false)
    }
    @PluginMethod fun deviceState(call: PluginCall) { main.post { call.resolve(deviceSnapshot()) } }
    @PluginMethod fun deviceHandoff(call: PluginCall) { main.post {
        try {
            val connection = EngineConnection.shared(context)
            val generation = call.getInt("generation")?.toLong() ?: -1L
            require(generation == connection.generation)
            val active = controller ?: error("NOT_READY")
            val target = call.getString("device_id") ?: error("NO_DEVICE")
            val future = active.sendCustomCommand(ProgramQueue.command, Bundle().apply {
                putString("action", "deviceHandoff"); putLong("generation", generation); putString("device_id", target)
            })
            future.addListener({
                try { require(alive && generation == connection.generation && future.get().resultCode == androidx.media3.session.SessionResult.RESULT_SUCCESS); call.resolve(deviceSnapshot()) }
                catch (_: Exception) { call.reject("Device handoff failed or session changed", "DEVICE_HANDOFF") }
            }, { task -> main.post(task) })
        } catch (_: Exception) { call.reject("Device handoff unavailable", "DEVICE_HANDOFF") }
    } }
    @PluginMethod fun deviceRename(call: PluginCall) { main.post {
        try {
            val connection = EngineConnection.shared(context)
            val generation = call.getInt("generation")?.toLong() ?: -1L
            require(generation == connection.generation)
            val active = controller ?: error("NOT_READY")
            val future = active.sendCustomCommand(ProgramQueue.command, Bundle().apply {
                putString("action", "deviceRename"); putLong("generation", generation); putString("name", call.getString("name") ?: error("NO_NAME"))
            })
            future.addListener({
                try { require(alive && generation == connection.generation && future.get().resultCode == androidx.media3.session.SessionResult.RESULT_SUCCESS); call.resolve(deviceSnapshot()) }
                catch (_: Exception) { call.reject("Device name rejected or session changed", "DEVICE_RENAME") }
            }, { task -> main.post(task) })
        } catch (_: Exception) { call.reject("Device rename unavailable", "DEVICE_RENAME") }
    } }
    private fun publish() { if (alive && visible) { notifyListeners("playbackState", snapshot()); notifyListeners("nativeLiveState", liveSnapshot()); notifyListeners("nativeDeviceState", deviceSnapshot()) } }
    @PluginMethod fun liveDirectory(call: PluginCall) {
        val connection = EngineConnection.shared(context)
        val generation = call.getInt("generation")?.toLong() ?: -1L
        val id = "live-directory-${java.util.UUID.randomUUID()}"
        liveRequests.add(id)
        try { liveWorker.execute {
            try {
                require(alive && generation == connection.generation)
                val result = NativeLiveDirectory.load(connection, generation, id)
                main.post { if (alive && generation == connection.generation) call.resolve(result) else call.reject("Live session changed", "LIVE_DIRECTORY") }
            } catch (_: NativeLiveAuthenticationExpired) { main.post { call.reject("Authentication expired", "AUTH_EXPIRED") } }
            catch (_: Exception) { main.post { call.reject("Live directory unavailable", "LIVE_DIRECTORY") } }
            finally { liveRequests.remove(id) }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { liveRequests.remove(id); call.reject("Live directory busy", "LIVE_DIRECTORY") }
    }
    @PluginMethod fun liveState(call: PluginCall) { main.post { call.resolve(liveSnapshot()) } }
    @PluginMethod fun liveCommand(call: PluginCall) { main.post {
        try {
            val connection = EngineConnection.shared(context)
            val generation = call.getInt("generation")?.toLong() ?: -1L
            require(generation == connection.generation)
            val active = controller ?: error("NOT_READY")
            val action = call.getString("action") ?: error("NO_ACTION")
            require(action in listOf("liveStart", "liveStop", "liveTitle", "liveChat", "liveListen", "liveLeave", "livePause", "liveResume", "liveVolume"))
            val args = Bundle().apply {
                putLong("generation", generation); putString("action", action)
                putString("title", call.getString("title")); putString("text", call.getString("text")); putFloat("volume", (call.getDouble("volume") ?: -1.0).toFloat())
                call.getObject("session")?.toString()?.let { require(it.length <= 65536); putString("session", it) }
            }
            val future = active.sendCustomCommand(ProgramQueue.command, args)
            future.addListener({
                try {
                    val result = future.get()
                    if (result.resultCode == androidx.media3.session.SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED) call.reject("Authentication expired", "AUTH_EXPIRED")
                    else {
                        require(alive && generation == connection.generation && result.resultCode == androidx.media3.session.SessionResult.RESULT_SUCCESS)
                        call.resolve(liveSnapshot())
                    }
                } catch (_: Exception) { call.reject("Live command unavailable or session changed", "LIVE_COMMAND") }
            }, { task -> main.post(task) })
        } catch (_: Exception) { call.reject("Live unavailable or session changed", "LIVE_COMMAND") }
    } }
    override fun handleOnPause() { visible = false; main.removeCallbacks(ticker) }
    override fun handleOnResume() { visible = true; main.removeCallbacks(ticker); if (controller != null) main.post(ticker) }
    @PluginMethod fun state(call: PluginCall) { main.post { call.resolve(snapshot()) } }
    @PluginMethod fun command(call: PluginCall) { main.post {
        try {
            val connection = EngineConnection.shared(context)
            require((call.getInt("generation")?.toLong() ?: -1L) == connection.generation)
            val p = controller ?: error("NOT_READY")
            when (call.getString("action")) {
                "djContext", "djRequest", "djRepair", "djSettings", "dj", "queue", "play", "select", "move", "remove", "append", "insertAfter", "retry", "stop", "skip", "radio", "autoplay", "leveling", "mixing", "metadata", "retireSource" -> {
                    val args = Bundle().apply {
                        if (call.getString("action") == "metadata") putString("metadataRevision", java.util.UUID.randomUUID().toString())
                        putBoolean("fromCurrent", call.getBoolean("fromCurrent") ?: true)
                        putString("direction", call.getObject("direction")?.toString()); putString("sources", call.getArray("sources")?.toString())
                        putBoolean("shuffle", call.getBoolean("shuffle") ?: false)
                        putBoolean("reload", call.getBoolean("reload") ?: false); putBoolean("enabled", call.getBoolean("enabled") ?: false); putString("profile", call.getString("profile"))
                        putInt("seconds", call.getInt("seconds") ?: 0)
                        putLong("generation", connection.generation)
                        putString("programToken", call.getString("programToken"))
                        putString("beforeKey", call.getString("beforeKey"))
                        putString("id", call.getString("id"))
                        putString("action", call.getString("action")); putString("queueToken", if (call.getString("action") in listOf("play", "queue")) ProgramQueue.token(p) else call.getString("queueToken")); putString("key", if (call.getString("action") == "play" && p.mediaItemCount > 0) ProgramQueue.key(p, p.currentMediaItemIndex) else call.getString("key"))
                        putString("tracks", call.getArray("tracks")?.toString())
                        putString("contextKind", call.getObject("context")?.getString("kind")); putString("contextId", call.getObject("context")?.getString("id"))
                        putInt("index", if (call.getString("action") == "play") p.currentMediaItemIndex else call.getInt("index") ?: if (call.getString("action") == "queue") 0 else -1); putInt("toIndex", call.getInt("toIndex") ?: -1)
                    }
                    val result = p.sendCustomCommand(ProgramQueue.command, args)
                    result.addListener({
                        try {
                            require(alive && args.getLong("generation") == connection.generation && result.get().resultCode == androidx.media3.session.SessionResult.RESULT_SUCCESS)
                            if (args.getString("action") == "stop") awaitClosed(call, p, connection, args.getLong("generation"), android.os.SystemClock.elapsedRealtime() + 3000)
                            else if (args.getString("action") == "retireSource") awaitRetired(call, p, connection, args, android.os.SystemClock.elapsedRealtime() + 3000)
                            else if (args.getString("action") == "metadata") awaitMetadata(call, p, connection, args, android.os.SystemClock.elapsedRealtime() + 3000)
                            else if (args.getString("action") == "queue") awaitQueue(call, p, connection, args, android.os.SystemClock.elapsedRealtime() + 3000)
                            else call.resolve(snapshot())
                        } catch (_: Exception) { call.reject("Queue changed or session unavailable", "PLAYBACK_COMMAND") }
                    }, java.util.concurrent.Executor { task -> main.post(task) })
                    return@post
                }
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
                else -> error("INVALID_COMMAND")
            }
            call.resolve(snapshot())
        } catch (_: Exception) { call.reject("Playback unavailable or session changed", "PLAYBACK_COMMAND") }
    } }
    private fun awaitMetadata(call: PluginCall, player: androidx.media3.session.MediaController, connection: EngineConnection, args: Bundle, deadline: Long) {
        if (!alive || connection.generation != args.getLong("generation")) { call.reject("Account changed", "PLAYBACK_COMMAND"); return }
        val rows = org.json.JSONArray(args.getString("tracks"))
        val updates = (0 until rows.length()).map { rows.getJSONObject(it) }.associateBy { it.getString("id") }
        val observed = (0 until player.mediaItemCount).all { index ->
            val item = player.getMediaItemAt(index); val row = updates[item.mediaId]
            row == null || item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) != "local" ||
                (item.mediaMetadata.extras?.getString("metadataRevision") == args.getString("metadataRevision") && item.mediaMetadata.title?.toString() == row.getString("title") && item.mediaMetadata.artist?.toString() == row.getString("artist") && item.mediaMetadata.albumTitle?.toString() == row.getString("album"))
        }
        if (observed) call.resolve(snapshot())
        else if (android.os.SystemClock.elapsedRealtime() >= deadline) call.reject("Metadata not observed", "PLAYBACK_COMMAND")
        else main.postDelayed({ awaitMetadata(call, player, connection, args, deadline) }, 25)
    }
    private fun awaitRetired(call: PluginCall, player: MediaController, connection: EngineConnection, args: Bundle, deadline: Long) {
        if (!alive || controller !== player || connection.generation != args.getLong("generation")) { call.reject("Session changed", "PLAYBACK_COMMAND"); return }
        if (player.mediaItemCount == 0) { awaitClosed(call, player, connection, args.getLong("generation"), deadline); return }
        val present = (0 until player.mediaItemCount).any { index ->
            val item = player.getMediaItemAt(index)
            item.mediaId == args.getString("id") && item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "local"
        }
        if (!present) call.resolve(snapshot())
        else if (android.os.SystemClock.elapsedRealtime() >= deadline) call.reject("Source retirement was not observed", "PLAYBACK_COMMAND")
        else main.postDelayed({ awaitRetired(call, player, connection, args, deadline) }, 20)
    }
    private fun awaitQueue(call: PluginCall, player: MediaController, connection: EngineConnection, args: Bundle, deadline: Long) {
        if (!alive || controller !== player || connection.generation != args.getLong("generation")) { call.reject("Session changed", "PLAYBACK_COMMAND"); return }
        val rows = org.json.JSONArray(args.getString("tracks"))
        if (ProgramQueue.token(player) != args.getString("queueToken") && player.mediaItemCount == rows.length() && player.currentMediaItemIndex == args.getInt("index") && (0 until rows.length()).all { player.getMediaItemAt(it).mediaId == rows.getJSONObject(it).getString("id") }) { call.resolve(snapshot()); return }
        if (android.os.SystemClock.elapsedRealtime() >= deadline) { call.reject("Queue replacement was not observed", "PLAYBACK_COMMAND"); return }
        main.postDelayed({ awaitQueue(call, player, connection, args, deadline) }, 20)
    }
    /** Custom-command result acknowledges service mutation; observe its IPC state before resolving. */
    private fun awaitClosed(call: PluginCall, player: MediaController, connection: EngineConnection, epoch: Long, deadline: Long) {
        if (!alive || controller !== player || connection.generation != epoch) { call.reject("Session changed", "PLAYBACK_COMMAND"); return }
        if (player.mediaItemCount == 0 && !player.playWhenReady && !player.shuffleModeEnabled && player.repeatMode == Player.REPEAT_MODE_OFF && player.playbackState == Player.STATE_IDLE && player.playerError == null) {
            call.resolve(snapshot()); return
        }
        if (android.os.SystemClock.elapsedRealtime() >= deadline) { call.reject("Program closure was not observed", "PLAYBACK_COMMAND"); return }
        main.postDelayed({ awaitClosed(call, player, connection, epoch, deadline) }, 20)
    }
    override fun handleOnDestroy() {
        alive = false; liveRequests.forEach { EngineConnection.shared(context).cancel(it) }; liveRequests.clear(); liveWorker.shutdownNow(); main.removeCallbacksAndMessages(null); controller?.removeListener(listener)
        pending?.let { MediaController.releaseFuture(it) }; controller = null
    }
}
