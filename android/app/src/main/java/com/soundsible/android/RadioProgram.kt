package com.soundsible.android

import android.os.Handler
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** NORMAL recommendation runway. Its requests and timers belong to the service. */
@UnstableApi
class RadioProgram(private val connection: EngineConnection, private val player: Player, private val main: Handler,
                   private val session: () -> MediaLibrarySession?, private val intent: String = "radio",
                   private val allowPlan: () -> Boolean = { true }, private val selectSeed: () -> androidx.media3.common.MediaItem? = { player.currentMediaItem }) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor()
    private var seed: JSONObject? = null
    private var profile = "balanced"
    private var serial = 0L
    private var generation = -1L
    private var lastCurrent = ""
    private var requestId: String? = null
    private var closed = false
    private var attempt = 0
    private var phase = "idle"
    private var errorStatus = 0
    private val heard = linkedSetOf<String>()
    private val generated = mutableSetOf<String>()
    private val retired = mutableSetOf<String>()
    private var scheduled = false
    private val refill = Runnable { scheduled = false; plan() }
    fun active(): Boolean = seed != null
    fun start(nextProfile: String) {
        require(nextProfile in listOf("familiar", "balanced", "explore"))
        val item = selectSeed() ?: error("NO_SEED")
        require(item.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true && connection.cookieHeader(connection.generation) != null)
        stop(); profile = nextProfile; generation = connection.generation
        seed = JSONObject().put("id", item.mediaId).put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "").put("album", item.mediaMetadata.albumTitle?.toString() ?: "")
            .put(if (item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "preview") "youtube_id" else "track_id", item.mediaId)
        sync()
    }
    fun manualInsertion(): Int? = if (seed == null) null else (player.currentMediaItemIndex + 1 until player.mediaItemCount).firstOrNull { ProgramQueue.key(player, it) in generated }
    fun stop() {
        val future = (player.currentMediaItemIndex + 1 until player.mediaItemCount).filter { ProgramQueue.key(player, it) in generated }.reversed()
        clear()
        future.forEach { player.removeMediaItem(it) }
    }
    /** Invalidate an in-flight plan before removing a private acquired source. */
    fun retire(id: String) {
        if (seed == null || closed) return
        retired.add(id); serial++; requestId?.let(connection::cancel); requestId = null
        main.removeCallbacks(refill); scheduled = false; attempt = 0; errorStatus = 0; phase = "ready"
        publish()
    }
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null; main.removeCallbacks(refill)
        scheduled = false; lastCurrent = ""; seed = null; generated.clear(); heard.clear(); retired.clear(); attempt = 0; errorStatus = 0; phase = "idle"; publish()
    }
    fun sync() {
        if (seed == null || closed) return
        if (generation != connection.generation || player.mediaItemCount == 0 || player.currentMediaItem?.mediaMetadata?.extras?.getBoolean(ProgramQueue.PODCAST) == true) { clear(); return }
        if (seed?.optString("track_id") in retired) {
            val replacement = selectSeed()?.takeIf { it.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true &&
                (it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) != "local" || it.mediaId !in retired) }
            if (replacement == null) { clear(); return }
            seed = JSONObject().put("id", replacement.mediaId).put("title", replacement.mediaMetadata.title?.toString() ?: "").put("artist", replacement.mediaMetadata.artist?.toString() ?: "").put("album", replacement.mediaMetadata.albumTitle?.toString() ?: "")
                .put(if (replacement.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "preview") "youtube_id" else "track_id", replacement.mediaId)
        }
        val current = ProgramQueue.key(player, player.currentMediaItemIndex)
        if (current != lastCurrent && phase == "exhausted") phase = "ready"
        lastCurrent = current
        heard.add(player.currentMediaItem!!.mediaId)
        while (heard.size > 80) heard.remove(heard.first())
        val present = (0 until player.mediaItemCount).map { ProgramQueue.key(player, it) }.toSet()
        generated.retainAll(present)
        // Drop consumed history only at the queue bound; manual future rows survive.
        if (player.mediaItemCount > 990 && player.currentMediaItemIndex > 0) player.removeMediaItems(0, player.currentMediaItemIndex)
        if (requestId == null && !scheduled && allowPlan() && phase !in listOf("exhausted", "blocked", "warming") && player.mediaItemCount - player.currentMediaItemIndex - 1 <= 5) { scheduled = true; main.post(refill) }
    }
    private fun publish() {
        session()?.let { owner -> owner.setSessionExtras(android.os.Bundle(owner.sessionExtras).apply { putLong("${intent}Generation", connection.generation); putBoolean("${intent}Active", seed != null); putString("${intent}Phase", phase); putString("${intent}Profile", profile); putInt("${intent}ErrorStatus", errorStatus) }) }
    }
    private fun plan() {
        if (intent == "autoplay" && seed != null) selectSeed()?.let { item ->
            seed = JSONObject().put("id", item.mediaId).put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "").put("album", item.mediaMetadata.albumTitle?.toString() ?: "")
                .put(if (item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "preview") "youtube_id" else "track_id", item.mediaId)
        }
        val original = seed ?: return
        if (!allowPlan()) { phase = "following_queue"; publish(); return }
        if (closed || requestId != null || generation != connection.generation) return
        val room = minOf(8, ProgramQueue.LIMIT - player.mediaItemCount)
        if (room <= 0) { phase = "exhausted"; publish(); return }
        val token = serial; val epoch = generation
        val id = "radio:" + java.util.UUID.randomUUID(); requestId = id
        val exclusions = heard + (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        val body = JSONObject().put("intent", intent).put("profile", profile).put("seed", original).put("limit", room).put("exclude", JSONArray(exclusions.toList())).toString().toRequestBody("application/json".toMediaType())
        phase = "planning"; publish()
        worker.execute {
            var answer: JSONObject? = null; var status = 0
            try { connection.execute("/api/discovery/music/plan", "POST", body, emptyMap(), epoch, id, 30000).use { response ->
                status = response.code
                if (response.isSuccessful) { val raw = response.peekBody(262145).string(); require(raw.toByteArray().size <= 262144); answer = JSONObject(raw) }
            } } catch (_: Exception) { }
            main.post {
                if (closed || serial != token || generation != connection.generation || seed == null) return@post
                requestId = null
                if (!allowPlan()) { phase = "following_queue"; publish(); return@post }
                if (status in listOf(401, 403)) { errorStatus = status; if (status == 401) player.pause(); phase = "blocked"; publish(); return@post }
                val response = answer
                try {
                    val nowExclude = heard + (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
                    val available = minOf(room, ProgramQueue.LIMIT - player.mediaItemCount)
                    val candidates = if (available > 0 && response != null) RadioPlan.rows(response, nowExclude, available) else JSONArray()
                    val rows = JSONArray()
                    for (index in 0 until candidates.length()) {
                        val row = candidates.getJSONObject(index)
                        if (row.optString("source") != "local" || row.optString("id") !in retired) rows.put(row)
                    }
                    if (rows.length() > 0) {
                        val items = ProgramQueue.items(connection, rows, ProgramQueue.programToken(player)).map { item -> item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(android.os.Bundle(item.mediaMetadata.extras).apply { putBoolean("${intent}Generated", true) }).build()).build() }
                        generated.addAll(items.map { it.mediaMetadata.extras!!.getString(ProgramQueue.KEY)!! })
                        player.addMediaItems(items); attempt = 0
                        phase = if (response!!.optBoolean("degraded")) "degraded" else "ready"; publish(); sync(); return@post
                    }
                } catch (_: Exception) { }
                val temporary = response == null || response.optBoolean("warming") || response.optString("empty_reason") == "temporary_failure"
                phase = if (temporary) "warming" else "exhausted"; publish()
                if (temporary && attempt < 5) {
                    val delays = longArrayOf(2000, 5000, 15000, 30000, 60000)
                    val delay = maxOf(delays[attempt++], ((response?.optDouble("retry_after", 0.0) ?: 0.0).coerceIn(0.0, 60.0) * 1000).toLong())
                    scheduled = true; main.postDelayed(refill, delay)
                }
            }
        }
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
