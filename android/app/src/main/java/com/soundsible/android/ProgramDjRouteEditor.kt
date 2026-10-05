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
    fun busy() = requestId != null
    fun repair() {
        val programme = owner() ?: error("NO_DJ")
        val snapshot = programme.routeSnapshot()
        val future = snapshot.rows.drop(snapshot.floor + 1).take(16)
        require(future.size >= 2)
        clear()
        val generation = connection.generation
        val identity = connection.sessionIdentity(generation)
        val token = serial
        val id = "dj-repair:" + java.util.UUID.randomUUID()
        val seed = snapshot.rows[snapshot.floor].item
        val body = JSONObject().put("dj_profile", planner.profile).put("seed", planner.reference(seed))
            .put("route", JSONArray(future.map { row -> planner.reference(row.item)
                .put("queue_id", key(row.item)).put("route_kind", row.kind) }))
            .put("source_policy", "explicit").put("sources", JSONArray(planner.sources.toString()))
            .put("exclude", JSONArray(snapshot.rows.take(snapshot.floor + 1).map { it.item.mediaId }))
        requestId = id; status("repairing", 0)
        try { worker.execute {
            var answer: JSONObject? = null; var code = 0
            try {
                connection.execute("/api/discovery/music/dj-repair", "POST",
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
                    status("cancelled", 0); return@post
                }
                if (code in listOf(401, 403)) { status("blocked", code); return@post }
                if (answer == null) { status("unavailable", code); return@post }
                try {
                    val result = rows(answer!!, seed, future)
                    if (!programme.repair(snapshot, result)) status("cancelled", 0)
                    else { revision++; status(if (answer!!.optBoolean("degraded")) "degraded" else "ready", 0) }
                } catch (_: Exception) { status("invalid", code) }
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) {
            requestId = null; status("unavailable", 0)
        }
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
        if (pending && !closed) status("cancelled", 0)
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
