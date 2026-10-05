package com.soundsible.android

import android.os.Handler
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** Scoped Core planning; temporary failures retain the programme and have a total retry budget. */
@UnstableApi
internal class ProgramDjPlanner(private val connection: EngineConnection, private val player: Player,
    private val main: Handler, private val status: (String, String, Int) -> Unit,
    private val ready: (List<ProgramDjSession.Row>, Long) -> Unit) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor()
    private var serial = 0L
    private var requestId: String? = null
    private var retry: Runnable? = null
    private var closed = false
    fun start(profile: String, direction: JSONObject, sources: JSONArray, fromCurrent: Boolean) {
        require(profile in listOf("adaptive", "long_blend", "cuts_drops", "open_format"))
        require(direction.toString().length <= 16384 && sources.length() <= 64 && sources.toString().length <= 65536)
        val seed = player.currentMediaItem.takeIf { fromCurrent }
        require(!fromCurrent || seed != null && seed.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true)
        require(seed != null || sources.length() > 0)
        clear()
        val token = serial; val generation = connection.generation
        val identity = connection.sessionIdentity(generation)
        val owner = ProgramQueue.programToken(player)
        val seedKey = seed?.mediaMetadata?.extras?.getString(ProgramQueue.KEY)
        val body = JSONObject().put("dj_profile", profile).put("direction", direction)
            .put("limit", 8).put("session_id", java.util.UUID.randomUUID().toString())
            .put("segment_index", 0).put("direction_revision", 0)
        if (sources.length() > 0) body.put("sources", sources).put("source_policy", "explicit")
        if (seed != null) body.put("seed", reference(seed)).put("exclude", JSONArray().put(seed.mediaId))
        val started = android.os.SystemClock.elapsedRealtime()
        var attempt = 0
        fun valid(): Boolean = !closed && token == serial && generation == connection.generation &&
            runCatching { connection.sessionIdentity(generation) }.getOrNull() == identity &&
            ProgramQueue.programToken(player) == owner && (seedKey == null ||
                player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.KEY) == seedKey)
        lateinit var request: Runnable
        request = Runnable {
            if (!valid()) { if (token == serial) status("cancelled", profile, 0); return@Runnable }
            val id = "dj-plan:" + java.util.UUID.randomUUID(); requestId = id
            status("planning", profile, 0)
            worker.execute {
                var answer: JSONObject? = null; var code = 0
                try {
                    connection.execute("/api/discovery/music/dj-plan", "POST",
                        body.toString().toRequestBody("application/json".toMediaType()), emptyMap(), generation, id, minOf(20000L, maxOf(1L, 60000 - (android.os.SystemClock.elapsedRealtime() - started)))).use { response ->
                        code = response.code
                        if (response.isSuccessful) {
                            val raw = response.peekBody(262145).string(); require(raw.toByteArray().size <= 262144)
                            answer = JSONObject(raw)
                        }
                    }
                } catch (_: Exception) { }
                main.post result@{
                    if (!valid()) { if (token == serial) { requestId = null; status("cancelled", profile, 0) }; return@result }
                    requestId = null
                    if (code in listOf(401, 403)) { status("blocked", profile, code); return@result }
                    val response = answer
                    try {
                        if (response != null) {
                            val parsed = rows(response, seed, generation)
                            if (parsed.size > if (seed == null) 0 else 1) {
                                status(if (response.optBoolean("degraded")) "degraded" else "ready", profile, 0)
                                ready(parsed, if (seed == null) 0 else player.currentPosition)
                                return@result
                            }
                        }
                    } catch (_: Exception) { status("invalid", profile, code); return@result }
                    val temporary = response == null || response.optBoolean("warming") || response.optString("empty_reason") == "temporary_failure"
                    val elapsed = android.os.SystemClock.elapsedRealtime() - started
                    if (temporary && elapsed < 60000 && attempt < 5) {
                        val delays = longArrayOf(2000, 4000, 8000, 12000, 16000)
                        val serverDelay = response?.optDouble("retry_after", 0.0)?.takeIf { it.isFinite() } ?: 0.0
                        val delay = maxOf(delays[attempt++], (serverDelay.coerceIn(0.0, 60.0) * 1000).toLong())
                        if (elapsed + delay < 60000) {
                            status("warming", profile, code); retry = request; main.postDelayed(request, delay); return@result
                        }
                    }
                    status(if (temporary) "unavailable" else "exhausted", profile, code)
                }
            }
        }
        main.post(request)
    }
    private fun reference(item: MediaItem) = JSONObject().put("id", item.mediaId)
        .put(if (item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "preview") "youtube_id" else "track_id", item.mediaId)
        .put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "")
        .put("album", item.mediaMetadata.albumTitle?.toString() ?: "")
    private fun rows(response: JSONObject, seed: MediaItem?, generation: Long): List<ProgramDjSession.Row> {
        require(generation == connection.generation)
        val owner = seed?.mediaMetadata?.extras?.getString(ProgramQueue.PROGRAM) ?: java.util.UUID.randomUUID().toString()
        val route = mutableListOf<ProgramDjSession.Row>()
        if (seed != null) route.add(ProgramDjSession.Row(seed))
        val items = JSONArray()
        if (seed == null) response.optJSONObject("opening")?.let { items.put(it) }
        val future = response.optJSONArray("items") ?: JSONArray()
        require(future.length() <= 64)
        for (index in 0 until future.length()) items.put(future.getJSONObject(index))
        val seen = mutableSetOf<String>(); seed?.let { seen.add(it.mediaId) }
        for (index in 0 until items.length()) {
            val candidate = items.getJSONObject(index)
            val decoded = RadioPlan.rows(JSONObject().put("items", JSONArray().put(candidate)), seen, 1)
            if (decoded.length() == 0) continue
            val item = ProgramQueue.items(connection, decoded, owner).single()
            seen.add(item.mediaId)
            val transition = candidate.optJSONObject("transition")
            val previous = route.lastOrNull()?.item?.mediaMetadata?.extras?.getString(ProgramQueue.KEY)
            val proposal = if (transition != null && previous != null) {
                val technique = runCatching { ProgramMixCurve.Technique.valueOf(transition.optString("technique").uppercase(java.util.Locale.ROOT)) }.getOrDefault(ProgramMixCurve.Technique.SAFE_FADE)
                ProgramDjPlan.Proposal(previous, technique, transition.optDouble("out_cue", Double.NaN),
                    transition.optDouble("in_cue", Double.NaN), transition.optDouble("overlap_seconds", Double.NaN),
                    transition.optDouble("playback_rate", Double.NaN), transition.optDouble("confidence", 0.0),
                    transition.optJSONObject("sync")?.optDouble("phase_tolerance_ms", 5.0) ?: 5.0)
            } else null
            route.add(ProgramDjSession.Row(item, proposal))
        }
        return route
    }
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null
        retry?.let(main::removeCallbacks); retry = null
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
