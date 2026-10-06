package com.soundsible.android

import android.os.Handler
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Scoped Core planning; temporary failures retain the programme and have a total retry budget. */
@UnstableApi
internal class ProgramDjPlanner(private val connection: EngineConnection, private val player: Player,
    private val main: Handler, private val heardIds: () -> Set<String>, private val status: (String, String, Int) -> Unit,
    private val ready: (List<ProgramDjSession.Row>, Long, Kind) -> Unit) : AutoCloseable {
    enum class Kind { START, REPLACE, APPEND }
    var settingsRevision = 0L; private set
    var profile = "adaptive"; private set
    var direction = JSONObject(); private set
    var sources = JSONArray(); private set
    private var restoredWorkspace = JSONObject()
    private var sessionId = ""
    private var segment = 0
    private var revision = 0
    fun busy() = requestId != null || retry != null
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1))
    @Volatile private var serial = 0L
    private var requestId: String? = null
    private var retry: Runnable? = null
    @Volatile private var closed = false
    fun restoreWorkspace(workspace: JSONObject) {
        val nextProfile = workspace.optString("djProfile", "adaptive")
        require(nextProfile in listOf("adaptive", "long_blend", "cuts_drops", "open_format"))
        val nextDirection = workspace.optJSONObject("direction") ?: JSONObject()
        val nextSources = workspace.optJSONArray("sources") ?: JSONArray()
        require(nextDirection.toString().length <= 16384 && nextSources.length() <= 6 && nextSources.toString().length <= 65536)
        for (i in 0 until nextSources.length()) require(nextSources.getJSONObject(i).getJSONArray("tracks").length() <= 15)
        clear(); profile = nextProfile; direction = JSONObject(nextDirection.toString()); sources = JSONArray(nextSources.toString())
        restoredWorkspace = JSONObject(workspace.toString()); settingsRevision++
        sessionId = java.util.UUID.randomUUID().toString(); segment = 0; revision = workspace.optInt("directionRevision", 0).coerceIn(0, 1000000)
    }
    fun workspace(): JSONObject = JSONObject(restoredWorkspace.toString()).put("profile", restoredWorkspace.optString("profile", "balanced"))
        .put("djProfile", profile).put("direction", JSONObject(direction.toString())).put("sources", JSONArray().apply {
            for (i in maxOf(0, sources.length() - 6) until sources.length()) {
                val source = JSONObject(sources.getJSONObject(i).toString())
                val tracks = source.optJSONArray("tracks") ?: JSONArray()
                source.put("tracks", JSONArray().apply { for (j in 0 until minOf(15, tracks.length())) put(tracks.getJSONObject(j)) })
                put(source)
            }
        }).put("directionRevision", revision).apply {
            if (sources.length() > 0 || restoredWorkspace.optString("sourcePolicy") == "explicit") put("sourcePolicy", "explicit")
            if (!has("avoidedIdentities")) put("avoidedIdentities", JSONArray())
            if (!has("exploration")) put("exploration", JSONArray())
        }
    fun start(profile: String, direction: JSONObject, sources: JSONArray, fromCurrent: Boolean,
        kind: Kind = Kind.START, anchor: MediaItem? = null, lead: MediaItem? = null) {
        require(profile in listOf("adaptive", "long_blend", "cuts_drops", "open_format"))
        require(direction.toString().length <= 16384 && sources.length() <= 64 && sources.toString().length <= 65536)
        val seed = anchor ?: player.currentMediaItem.takeIf { fromCurrent }
        require(seed?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) != "pending")
        require(!fromCurrent || seed != null && seed.mediaMetadata.extras?.getBoolean(ProgramQueue.PODCAST) != true)
        require(seed != null || sources.length() > 0)
        clear()
        if (kind == Kind.START) restoredWorkspace = JSONObject()
        if (this.profile != profile || this.direction.toString() != direction.toString() || this.sources.toString() != sources.toString()) settingsRevision++
        this.profile = profile; this.direction = JSONObject(direction.toString()); this.sources = JSONArray(sources.toString())
        if (kind == Kind.START) { sessionId = java.util.UUID.randomUUID().toString(); segment = 0; revision = 0 }
        else if (kind == Kind.REPLACE) revision++
        else segment++
        val token = serial; val generation = connection.generation
        val identity = connection.sessionIdentity(generation)
        val owner = ProgramQueue.programToken(player)
        val queue = ProgramQueue.token(player)
        val seedKey = seed?.mediaMetadata?.extras?.getString(ProgramQueue.KEY)
        val body = JSONObject().put("dj_profile", profile).put("direction", direction)
            .put("limit", 8).put("session_id", sessionId)
            .put("segment_index", segment).put("direction_revision", revision)
        if (sources.length() > 0 || restoredWorkspace.optString("sourcePolicy") == "explicit") body.put("sources", sources).put("source_policy", "explicit")
        val exploration = restoredWorkspace.optJSONArray("exploration") ?: JSONArray()
        body.put("exploration", JSONArray().apply { for (i in maxOf(0, exploration.length() - 4) until exploration.length()) put(exploration.getJSONObject(i)) })
        val heard = restoredWorkspace.optJSONArray("heard") ?: JSONArray()
        body.put("heard", JSONArray().apply { for (i in maxOf(0, heard.length() - 15) until heard.length()) put(heard.getJSONObject(i)) })
        val avoided = restoredWorkspace.optJSONArray("avoidedIdentities") ?: JSONArray()
        val excluded = (0 until minOf(60, avoided.length())).flatMap { i ->
            val id = avoided.optString(i)
            listOf(id, id.removePrefix("music:track:").removePrefix("music:youtube:"))
        }.filter { it.isNotBlank() && it.length <= 512 }
        if (seed != null) body.put("seed", reference(seed)).put("exclude", JSONArray(
            ((if (kind == Kind.START) listOf(seed.mediaId) else (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId } + heardIds()) + excluded).distinct()))
        val started = android.os.SystemClock.elapsedRealtime()
        var attempt = 0
        fun valid(): Boolean = !closed && token == serial && generation == connection.generation &&
            runCatching { connection.sessionIdentity(generation) }.getOrNull() == identity &&
            ProgramQueue.programToken(player) == owner && (seedKey == null ||
                if (kind == Kind.APPEND) ProgramQueue.token(player) == queue && (0 until player.mediaItemCount).any { ProgramQueue.key(player, it) == seedKey }
                else player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.KEY) == seedKey)
        lateinit var request: Runnable
        request = Runnable {
            retry = null
            if (!valid()) { if (token == serial) status("cancelled", profile, 0); return@Runnable }
            val id = "dj-plan:" + java.util.UUID.randomUUID(); requestId = id
            status("planning", profile, 0)
            worker.execute {
                if (closed || token != serial || generation != connection.generation) return@execute
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
                            val actualSeed = seedKey?.let { key -> (0 until player.mediaItemCount).firstOrNull { ProgramQueue.key(player, it) == key }?.let(player::getMediaItemAt) }
                            val planned = rows(response, actualSeed, generation)
                            fun sameReference(a: MediaItem, b: MediaItem) = a.mediaId == b.mediaId &&
                                a.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == b.mediaMetadata.extras?.getString(ProgramQueue.SOURCE)
                            val parsed = if (lead != null && actualSeed != null && !sameReference(lead, actualSeed)) {
                                val marked = lead.buildUpon().setMediaMetadata(lead.mediaMetadata.buildUpon()
                                    .setExtras(android.os.Bundle(lead.mediaMetadata.extras).apply { putBoolean(ProgramDjSession.CONTEXT_LEAD, true) }).build()).build()
                                planned.take(1) + ProgramDjSession.Row(marked) + planned.drop(1).filter { !sameReference(it.item, lead) }
                            } else planned
                            if (parsed.size > if (seed == null) 0 else 1) {
                                status(if (response.optBoolean("degraded")) "degraded" else "ready", profile, 0)
                                ready(parsed, if (seed == null) 0 else player.currentPosition, kind)
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
        retry = request; main.post(request)
    }
    fun reference(item: MediaItem) = JSONObject().put("id", item.mediaId)
        .put(if (item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) == "preview") "youtube_id" else "track_id", item.mediaId)
        .put("title", item.mediaMetadata.title?.toString() ?: "").put("artist", item.mediaMetadata.artist?.toString() ?: "")
        .put("album", item.mediaMetadata.albumTitle?.toString() ?: "")
        .put("source", item.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) ?: "")
        .put("duration", item.mediaMetadata.extras?.getDouble(ProgramPcmProcessor.DURATION, 0.0) ?: 0.0)
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
            val previous = route.lastOrNull()?.item?.mediaMetadata?.extras?.getString(ProgramQueue.KEY)
            route.add(ProgramDjSession.Row(item, proposal(candidate, previous), "generated"))
        }
        return route
    }
    fun proposal(candidate: JSONObject, previous: String?): ProgramDjPlan.Proposal? {
        val transition = candidate.optJSONObject("transition")
        return if (transition != null && previous != null) {
            val technique = runCatching { ProgramMixCurve.Technique.valueOf(transition.optString("technique").uppercase(java.util.Locale.ROOT)) }.getOrDefault(ProgramMixCurve.Technique.SAFE_FADE)
            ProgramDjPlan.Proposal(previous, technique, transition.optDouble("out_cue", Double.NaN),
                transition.optDouble("in_cue", Double.NaN), transition.optDouble("overlap_seconds", Double.NaN),
                transition.optDouble("playback_rate", Double.NaN), transition.optDouble("confidence", 0.0),
                transition.optJSONObject("sync")?.optDouble("phase_tolerance_ms", 5.0) ?: 5.0)
        } else null
    }
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null
        retry?.let(main::removeCallbacks); retry = null
        worker.queue.clear()
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
