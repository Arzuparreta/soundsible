package com.soundsible.android

import android.os.Handler
import androidx.media3.common.util.UnstableApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Best-effort cached analysis before a decoder's cue/rate becomes committed. */
@UnstableApi
internal class ProgramDjRefiner(private val connection: EngineConnection, private val main: Handler,
    private val session: () -> ProgramDjSession?, private val planner: ProgramDjPlanner) : AutoCloseable {
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1))
    private var pair = ""
    @Volatile private var serial = 0L
    @Volatile private var closed = false
    private var requestId: String? = null
    fun refine(owner: ProgramDjSession) {
        if (closed || session() !== owner) return
        val snapshot = owner.routeSnapshot()
        val from = snapshot.rows.getOrNull(snapshot.floor)?.item ?: return
        val next = snapshot.rows.getOrNull(snapshot.floor + 1) ?: return
        val fromKey = from.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: return
        val toKey = next.item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: return
        if (next.proposal?.let { it.fromKey == fromKey && it.confidence.isFinite() && it.confidence >= 0.35 } == true) return
        val identity = "${snapshot.epoch}:${planner.settingsRevision}:$fromKey>$toKey"
        if (pair == identity) return
        clear(); pair = identity
        val token = serial; val generation = connection.generation
        val account = connection.sessionIdentity(generation)
        val profile = planner.profile
        val settingsRevision = planner.settingsRevision
        val body = JSONObject().put("dj_profile", profile).put("from", planner.reference(from)).put("to", planner.reference(next.item))
        val id = "dj-refine:" + java.util.UUID.randomUUID(); requestId = id
        worker.execute {
            if (closed || token != serial) return@execute
            var response: JSONObject? = null
            try {
                connection.execute("/api/discovery/music/dj-transition", "POST",
                    body.toString().toRequestBody("application/json".toMediaType()), emptyMap(), generation, id, 8000).use {
                    if (it.isSuccessful) {
                        val raw = it.peekBody(262145).string()
                        require(raw.toByteArray().size <= 262144)
                        response = JSONObject(raw)
                    }
                }
            } catch (_: Exception) { }
            main.post {
                if (closed || token != serial) return@post
                requestId = null
                if (generation != connection.generation || session() !== owner || profile != planner.profile || settingsRevision != planner.settingsRevision ||
                    runCatching { connection.sessionIdentity(generation) }.getOrNull() != account) return@post
                val answer = response ?: return@post
                if (!answer.optBoolean("measured")) return@post
                planner.proposal(answer, fromKey)?.let { owner.applyRefinement(snapshot, it) }
            }
        }
    }
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null
        pair = ""; worker.queue.clear()
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
