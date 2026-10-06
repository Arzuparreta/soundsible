package com.soundsible.android

import android.os.Handler
import android.os.Bundle
import androidx.media3.common.Player
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

/** Account preferences and NORMAL continuation belong to the service. */
@UnstableApi
class AutoplayProgram(private val connection: EngineConnection, private val player: Player, private val main: Handler,
                      private val session: () -> MediaLibrarySession?, private val radioActive: () -> Boolean) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor()
    private var enabled: Boolean? = null
    private var settingsPhase = "idle"
    private var epoch = -1L
    private var serial = 0L
    private var requestId: String? = null
    private var closed = false
    private val runway = RadioProgram(connection, player, main, session, "autoplay", { eligible() }, { seed() })
    private fun future(): List<MediaItem> = (player.currentMediaItemIndex + 1 until player.mediaItemCount).map(player::getMediaItemAt)
    private fun seed(): MediaItem? = future().lastOrNull { it.mediaMetadata.extras?.getBoolean("autoplayGenerated") == true }
        ?: future().lastOrNull() ?: player.currentMediaItem
    private fun eligible(): Boolean = enabled == true && !radioActive() && player.repeatMode == Player.REPEAT_MODE_OFF &&
        player.currentMediaItem != null && player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) != "pending" &&
        future().none { it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "pending" } && player.currentMediaItem?.mediaMetadata?.extras?.getBoolean(ProgramQueue.PODCAST) != true &&
        future().none { it.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) == true } &&
        future().count { it.mediaMetadata.extras?.getBoolean("autoplayGenerated") != true } <= 2 &&
        connection.cookieHeader(connection.generation) != null
    private fun publish() {
        session()?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putLong("autoplayGeneration", connection.generation); putString("autoplaySettingsPhase", settingsPhase)
            putBoolean("autoplayKnown", enabled != null); putBoolean("autoplayEnabled", enabled == true)
        }) }
    }
    fun sync() {
        if (closed) return
        if (epoch != connection.generation) clear()
        if (player.mediaItemCount == 0 || connection.cookieHeader(connection.generation) == null) return
        if (enabled == null && settingsPhase == "idle") settings(null)
        if (radioActive() || player.repeatMode != Player.REPEAT_MODE_OFF || player.currentMediaItem?.mediaMetadata?.extras?.getBoolean(ProgramQueue.PODCAST) == true) {
            if (runway.active()) runway.stop()
            return
        }
        if (eligible() && !runway.active()) runway.start("balanced")
        else if (runway.active()) runway.sync()
    }
    /** Null reloads; boolean writes and confirms the engine preference before changing behaviour. */
    fun settings(value: Boolean?) {
        if (closed) return
        serial++; requestId?.let(connection::cancel)
        val token = serial; val generation = connection.generation; epoch = generation
        val id = "autoplay-settings:" + java.util.UUID.randomUUID(); requestId = id
        settingsPhase = "loading"; publish()
        worker.execute {
            var answer: Boolean? = null
            try {
                val body = value?.let { JSONObject().put("autoplay_enabled", it).toString().toRequestBody("application/json".toMediaType()) }
                connection.execute("/api/discovery/settings", if (value == null) "GET" else "PATCH", body, emptyMap(), generation, id, 15000).use { response ->
                    if (response.isSuccessful) {
                        val raw = response.peekBody(65537).string(); require(raw.toByteArray().size <= 65536)
                        val parsed = JSONObject(raw); require(parsed.get("autoplay_enabled") is Boolean)
                        answer = parsed.getBoolean("autoplay_enabled"); require(value == null || answer == value)
                    }
                }
            } catch (_: Exception) { }
            main.post {
                if (closed || token != serial || generation != connection.generation) return@post
                requestId = null; settingsPhase = if (answer == null) "unavailable" else "ready"
                if (answer != null) enabled = answer
                if (enabled == false && runway.active()) runway.stop()
                publish(); sync()
            }
        }
    }
    fun suspend() { if (runway.active()) runway.stop() }
    fun retire(id: String) { runway.retire(id) }
    fun restoreGenerated(keys: Set<String>) {
        if (keys.isEmpty() || player.currentMediaItem == null) return
        val item = seed() ?: return
        runway.restore(JSONObject().put("active", true).put("seedId", item.mediaId).put("profile", "balanced"), keys)
    }
    fun manualInsertion(): Int? = runway.manualInsertion()
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null
        runway.clear(); enabled = null; epoch = connection.generation; settingsPhase = "idle"; publish()
    }
    override fun close() { closed = true; clear(); runway.close(); worker.shutdownNow() }
}
