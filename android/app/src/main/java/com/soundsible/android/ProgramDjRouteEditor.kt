package com.soundsible.android

import android.os.Handler
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Core route repair, scoped to the exact programme, future and output epoch. */
@UnstableApi
internal class ProgramDjRouteEditor(private val connection: EngineConnection, private val main: Handler,
    private val owner: () -> ProgramDjSession?, private val planner: ProgramDjPlanner,
    private val status: (String, Int) -> Unit) : AutoCloseable {
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1))
    @Volatile private var serial = 0L
    private var requestId: String? = null
    private var closed = false
    var revision = 0L; private set
    var outcome = "idle"; private set
    var requestTitle = ""; private set
    fun busy() = requestId != null
    fun repair() {
        val programme = owner() ?: error("NO_DJ")
        val snapshot = programme.routeSnapshot()
        val future = snapshot.rows.drop(snapshot.floor + 1).take(16)
        require(future.size >= 2)
        val seed = snapshot.rows[snapshot.floor].item
        val body = body(snapshot).put("route", JSONArray(future.map { row -> reference(row) }))
        submit(programme, snapshot, body, "dj-repair", "repairing", false) { answer ->
            rows(answer, seed, future) + snapshot.rows.drop(snapshot.floor + 17)
        }
    }
    fun place(track: MediaItem, beforeKey: String?) {
        val programme = owner() ?: error("NO_DJ")
        clear()
        val snapshot = programme.addRequested(track, beforeKey)
        val future = snapshot.rows.drop(snapshot.floor + 1).filter { key(it.item) != key(track) }
        val horizon = if (beforeKey == null) future.take(16) else future
        val payload = body(snapshot).put("route", JSONArray(horizon.map { reference(it) }))
            .put("track", planner.reference(track)).put("requested_queue_id", key(track))
        beforeKey?.let { payload.put("before_queue_id", it) }
        submit(programme, snapshot, payload, "dj-place", "placing", true, track.mediaMetadata.title?.toString() ?: "") { answer ->
            placement(answer, snapshot.rows[snapshot.floor].item, future, track, beforeKey)
        }
    }
    private fun reference(row: ProgramDjSession.Row) = planner.reference(row.item).put("queue_id", key(row.item)).put("route_kind", row.kind)
    private fun body(snapshot: ProgramDjSession.RouteSnapshot) = JSONObject()
        .put("dj_profile", planner.profile).put("seed", planner.reference(snapshot.rows[snapshot.floor].item))
        .put("source_policy", "explicit").put("sources", JSONArray(planner.sources.toString()))
        .put("exclude", JSONArray(snapshot.rows.take(snapshot.floor + 1).map { it.item.mediaId }))
    private fun submit(programme: ProgramDjSession, snapshot: ProgramDjSession.RouteSnapshot, body: JSONObject,
        endpoint: String, phase: String, keepRequest: Boolean, title: String = "",
        decode: (JSONObject) -> List<ProgramDjSession.Row>) {
        clear()
        val generation = connection.generation
        val identity = connection.sessionIdentity(generation)
        val token = serial
        val id = endpoint + ":" + java.util.UUID.randomUUID()
        outcome = "pending"; requestTitle = title
        fun failed(code: Int) {
            if (keepRequest) { outcome = "placement_fallback"; revision++; status("degraded", code) }
            else { outcome = "failed"; status("unavailable", code) }
        }
        requestId = id; status(phase, 0)
        try { worker.execute {
            var answer: JSONObject? = null; var code = 0
            try {
                require(body.toString().toByteArray().size <= 262144)
                connection.execute("/api/discovery/music/$endpoint", "POST",
                    body.toString().toRequestBody("application/json".toMediaType()), emptyMap(), generation, id, 20000).use { response ->
                    code = response.code
                    if (response.isSuccessful) {
                        val raw = response.peekBody(262145).string(); require(raw.toByteArray().size <= 262144)
                        answer = JSONObject(raw)
                    }
                }
            } catch (_: Exception) { }
            main.post {
                if (closed || token != serial || generation != connection.generation || owner() !== programme) return@post
                requestId = null
                if (runCatching { connection.sessionIdentity(generation) }.getOrNull() != identity || !programme.snapshotCurrent(snapshot)) {
                    outcome = "cancelled"; status("cancelled", 0); return@post
                }
                if (code in listOf(401, 403)) { outcome = "blocked"; status("blocked", code); return@post }
                if (answer == null) { failed(code); return@post }
                try {
                    val result = decode(answer!!)
                    if (!programme.editFuture(snapshot, result)) { outcome = "cancelled"; status("cancelled", 0) }
                    else { outcome = if (keepRequest) "placed" else "repaired"; revision++; status(if (answer!!.optBoolean("degraded")) "degraded" else "ready", 0) }
                } catch (_: Exception) {
                    if (keepRequest) failed(code) else { outcome = "failed"; status("invalid", code) }
                }
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) {
            requestId = null; failed(0)
        }
    }
    private fun placement(response: JSONObject, seed: MediaItem, future: List<ProgramDjSession.Row>, requested: MediaItem, beforeKey: String?): List<ProgramDjSession.Row> {
        require(response.getInt("v") == 1 && response.getString("requested_queue_id") == key(requested))
        val insertion = response.getInt("insert_at")
        require(insertion in 0..future.size)
        if (beforeKey != null) require(insertion == future.indexOfFirst { key(it.item) == beforeKey })
        else require(insertion <= 16)
        val items = response.getJSONArray("items"); require(items.length() in 1..3)
        val additions = mutableListOf<ProgramDjSession.Row>()
        var previous = if (insertion == 0) key(seed) else key(future[insertion - 1].item)
        var requests = 0
        for (index in 0 until items.length()) {
            val candidate = items.getJSONObject(index)
            val kind = candidate.getString("route_kind"); require(kind in listOf("user", "bridge"))
            val decoded = RadioPlan.rows(JSONObject().put("items", JSONArray().put(candidate)), emptySet(), 1)
            require(decoded.length() == 1)
            val parsed = decoded.getJSONObject(0)
            val item = if (kind == "user") {
                require(parsed.getString("id") == requested.mediaId && parsed.getString("source") == requested.mediaMetadata.extras!!.getString(ProgramQueue.SOURCE))
                requests++; requested
            } else ProgramQueue.items(connection, decoded, requested.mediaMetadata.extras!!.getString(ProgramQueue.PROGRAM)!!).single()
            additions.add(ProgramDjSession.Row(item, planner.proposal(candidate, previous), kind)); previous = key(item)
        }
        require(requests == 1)
        val tail = future.drop(insertion).toMutableList()
        response.optJSONObject("following_transition")?.let { transition ->
            if (tail.isNotEmpty()) tail[0] = tail[0].copy(proposal = planner.proposal(JSONObject().put("transition", transition), previous))
        }
        return future.take(insertion) + additions + tail
    }
    private fun key(item: MediaItem) = item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: ""
    private fun rows(response: JSONObject, seed: MediaItem, future: List<ProgramDjSession.Row>): List<ProgramDjSession.Row> {
        require(response.getInt("v") == 1)
        val items = response.getJSONArray("items"); require(items.length() in 1..64)
        val byKey = future.associateBy { key(it.item) }
        val anchors = future.filter { it.kind == "user" }.map { key(it.item) }
        val returned = mutableListOf<String>()
        val seenKeys = mutableSetOf<String>()
        val result = mutableListOf<ProgramDjSession.Row>()
        var previous = key(seed)
        val programme = seed.mediaMetadata.extras!!.getString(ProgramQueue.PROGRAM)!!
        for (index in 0 until items.length()) {
            val candidate = items.getJSONObject(index)
            val kind = candidate.getString("route_kind"); require(kind in listOf("user", "generated", "bridge"))
            val keptKey = candidate.optString("queue_id").takeIf { it.isNotBlank() && it != "null" }
            val kept = keptKey?.let { byKey[it] ?: error("UNKNOWN_OCCURRENCE") }
            val decoded = RadioPlan.rows(JSONObject().put("items", JSONArray().put(candidate)), emptySet(), 1)
            require(decoded.length() == 1)
            val parsed = decoded.getJSONObject(0)
            val item = if (kept != null) {
                require(parsed.getString("id") == kept.item.mediaId && parsed.getString("source") == kept.item.mediaMetadata.extras!!.getString(ProgramQueue.SOURCE))
                if (kind == "user") { require(kept.kind == "user"); returned.add(keptKey!!) }
                kept.item
            } else {
                require(kind != "user")
                ProgramQueue.items(connection, decoded, programme).single()
            }
            require(seenKeys.add(key(item)))
            result.add(ProgramDjSession.Row(item, planner.proposal(candidate, previous), kind))
            previous = key(item)
        }
        require(returned == anchors) { "REPAIR_LOST_USER_ANCHOR" }
        return result
    }
    fun clear() {
        val pending = requestId != null
        serial++; requestId?.let(connection::cancel); requestId = null; worker.queue.clear()
        outcome = if (pending) "cancelled" else "idle"; requestTitle = ""
        if (pending && !closed) status("cancelled", 0)
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
