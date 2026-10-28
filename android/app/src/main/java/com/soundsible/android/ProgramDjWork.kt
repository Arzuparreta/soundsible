package com.soundsible.android

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Server demand belongs to this service programme, independently of its Activity. */
internal class ProgramDjWork(private val connection: EngineConnection) : AutoCloseable {
    private val client = "dj-android-" + java.util.UUID.randomUUID()
    private var epoch = 0L
    private var revision = 0L
    private var active = false
    private var signature = ""
    private var lastSent = 0L
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue<Runnable>(32), ThreadPoolExecutor.DiscardOldestPolicy())
    @Synchronized fun headers(requestId: String? = null): Map<String, String> = buildMap {
        put("X-Soundsible-Work", JSONObject().put("client", client).put("epoch", epoch).toString())
        requestId?.let { put("X-Soundsible-Work-Request", it.replace(':', '-')) }
    }
    @Synchronized fun begin() { epoch++; active = true; signature = ""; lastSent = 0; sync(JSONArray()) }
    @Synchronized fun sync(tracks: JSONArray) {
        if (!active) return
        val next = tracks.toString()
        val now = android.os.SystemClock.elapsedRealtime()
        if (next == signature && now - lastSent < 15000) return
        if (next != signature) revision++
        signature = next; lastSent = now
        send(JSONObject().put("active", true).put("revision", revision).put("tracks", tracks), headers())
    }
    fun cancel(requestId: String, headers: Map<String, String>) {
        send(JSONObject().put("cancel_request", requestId.replace(':', '-')),
            headers.filterKeys { it != "X-Soundsible-Work-Request" })
    }
    @Synchronized fun release() {
        if (!active) return
        active = false; signature = ""
        send(JSONObject().put("active", false).put("revision", ++revision), headers())
    }
    private fun send(body: JSONObject, headers: Map<String, String>) {
        val generation = connection.generation
        if (worker.isShutdown) return
        try { worker.execute {
            runCatching {
                connection.execute("/api/discovery/music/dj-work", "POST",
                    body.toString().toRequestBody("application/json".toMediaType()), headers,
                    generation, "dj-work:" + java.util.UUID.randomUUID(), 8000).close()
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) { }
    }
    override fun close() { release(); worker.shutdown() }
}
