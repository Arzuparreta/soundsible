package com.soundsible.android

import android.content.Context
import android.os.Bundle
import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Confirmed Core preference, owned by the native programme service. */
@UnstableApi
internal class ProgramLeveling(context: Context, private val connection: EngineConnection, private val main: Handler,
    private val session: () -> MediaLibrarySession?) : AutoCloseable {
    private val prefs = context.getSharedPreferences("program-audio", Context.MODE_PRIVATE)
    private fun profile(generation: Long) = runCatching { connection.offline.profileKey(generation) }.getOrNull()
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1))
    @Volatile private var enabled: Boolean? = null
    @Volatile private var epoch = -1L
    @Volatile var shuffle = false
    private var phase = "idle"
    private var serial = 0L
    private var requestId: String? = null
    private var closed = false
    fun active() = epoch == connection.generation && enabled == true
    private fun publish() {
        session()?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putLong("levelingGeneration", connection.generation); putString("levelingSettingsPhase", phase)
            putBoolean("levelingKnown", enabled != null && epoch == connection.generation); putBoolean("levelingEnabled", active())
        }) }
    }
    fun sync(hasProgramme: Boolean) {
        if (closed) return
        if (epoch != connection.generation) clear()
        if (hasProgramme && phase == "idle") {
            profile(connection.generation)?.let { key ->
                if (prefs.contains(key + ".leveling")) { enabled = prefs.getBoolean(key + ".leveling", false); phase = "cached"; publish() }
            }
            if (connection.cookieHeader(connection.generation) != null) settings(null)
            else { phase = "unavailable"; publish() }
        }
    }
    fun settings(value: Boolean?) {
        if (closed || requestId != null) return
        val generation = connection.generation
        val sessionIdentity = runCatching { connection.sessionIdentity(generation) }.getOrNull()
        if (sessionIdentity == null) { phase = "unavailable"; publish(); return }
        val profileKey = profile(generation)
        val token = ++serial; val id = "leveling-settings:" + java.util.UUID.randomUUID(); requestId = id
        phase = "loading"; publish()
        try { worker.execute {
            var answer: Boolean? = null
            try {
                fun read(method: String, requested: Boolean?): Boolean {
                    val body = requested?.let { JSONObject().put("volume_leveling", it).toString().toRequestBody("application/json".toMediaType()) }
                    connection.execute("/api/discovery/settings", method, body, emptyMap(), generation, id, 15000).use { response ->
                        require(response.isSuccessful)
                        val raw = response.peekBody(65537).string(); require(raw.toByteArray().size <= 65536)
                        val parsed = JSONObject(raw); require(parsed.get("volume_leveling") is Boolean)
                        return parsed.getBoolean("volume_leveling")
                    }
                }
                if (value != null) require(read("PATCH", value) == value)
                val confirmed = read("GET", null); require(value == null || confirmed == value); answer = confirmed
            } catch (_: Exception) { }
            main.post {
                if (closed || token != serial || generation != connection.generation) return@post
                if (runCatching { connection.sessionIdentity(generation) }.getOrNull() != sessionIdentity) {
                    requestId = null; enabled = null; phase = "unavailable"; publish(); return@post
                }
                requestId = null; phase = if (answer == null) "unavailable" else "ready"
                if (answer != null) {
                    epoch = generation; enabled = answer
                    if (profileKey != null && profileKey == profile(generation)) prefs.edit().putBoolean(profileKey + ".leveling", answer!!).apply()
                }
                publish()
            }
        } } catch (_: java.util.concurrent.RejectedExecutionException) {
            requestId = null; phase = "unavailable"; publish()
        }
    }
    fun clear() {
        serial++; requestId?.let(connection::cancel); requestId = null
        enabled = null; epoch = connection.generation; phase = "idle"; shuffle = false; publish()
    }
    override fun close() { closed = true; clear(); worker.shutdownNow() }
}
