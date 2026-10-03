package com.soundsible.android

import android.os.Bundle
import android.os.Handler
import android.os.SystemClock
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

/** Service-owned observations. Polling never initiates downloads or cancels another listener's fill. */
@UnstableApi
class PreviewProgram(private val connection: EngineConnection, private val player: Player, private val main: Handler,
                     private val session: () -> MediaLibrarySession?, private val cancelAudio: (String) -> Unit) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var key = ""
    @Volatile private var epoch = -1L
    @Volatile private var serial = 0L
    @Volatile private var retry = PreviewRetry(SystemClock::elapsedRealtime, System::currentTimeMillis)
    private var preparation: String? = null
    private var authFailure = false
    private var requestId: String? = null
    private var closed = false
    private val poll = Runnable { poll() }
    private fun preparationState(): String? = preparation?.let { JSONObject(it).optString("state") }
    private fun shouldPoll(): Boolean = key.isNotEmpty() && player.playerError == null && !authFailure && when (preparationState()) {
        "ready", "unavailable" -> false
        "cold" -> player.playbackState == Player.STATE_BUFFERING
        else -> true
    }
    @Synchronized fun sync() {
        val item = player.currentMediaItem
        val next = if (item?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) == "preview") item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: "" else ""
        if (next == key && epoch == connection.generation) {
            if (key.isNotEmpty() && player.playerError != null) { retry.loaded(); main.removeCallbacks(poll); publish() }
            if (requestId == null && shouldPoll()) {
                main.removeCallbacks(poll); main.postDelayed(poll, 1000)
            }
            return
        }
        clear(); key = next; epoch = connection.generation
        if (key.isNotEmpty()) { publish(); main.post(poll) }
    }
    @Synchronized fun clear() {
        if (key.isNotEmpty()) cancelAudio(key)
        serial++; main.removeCallbacks(poll); requestId?.let(connection::cancel); requestId = null
        key = ""; preparation = null; authFailure = false
        retry = PreviewRetry(SystemClock::elapsedRealtime, System::currentTimeMillis)
        session()?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply { keySet().filter { it.startsWith("preview") }.forEach { remove(it) } }) }
    }
    private fun publish() {
        if (key.isEmpty()) return
        session()?.let { owner -> owner.setSessionExtras(Bundle(owner.sessionExtras).apply {
            putString("previewKey", key); putLong("previewGeneration", epoch)
            putString("previewPreparation", preparation); putInt("previewRetryAttempt", retry.attempts)
            putBoolean("previewRetryPending", retry.pending)
            putLong("previewRetryNotBefore", retry.remaining().let { if (it > 0) System.currentTimeMillis().let { wall -> wall + it.coerceAtMost(Long.MAX_VALUE - wall) } else 0 })
            putBoolean("previewAuthFailure", authFailure)
        }) }
    }
    private fun poll() {
        if (closed || requestId != null || !shouldPoll()) return
        val token = serial; val selected = key; val generation = epoch
        val id = player.currentMediaItem?.mediaId ?: return
        val callId = "preview-service-$generation-$token"
        requestId = callId
        worker.execute {
            var result: String? = null; var unauthorized = false
            try {
                val body = JSONObject().put("video_ids", org.json.JSONArray().put(id)).toString().toRequestBody("application/json".toMediaType())
                connection.execute("/api/preview/status", "POST", body, emptyMap(), generation, callId, 8000).use {
                    unauthorized = it.code == 401
                    if (it.isSuccessful) result = JSONObject(it.body?.string() ?: "{}").optJSONObject("preparation")?.optJSONObject(id)?.toString()
                }
            } catch (_: Exception) { /* Observability failure does not invent an audio error. */ }
            main.post {
                if (closed || serial != token || key != selected || generation != connection.generation) return@post
                requestId = null
                if (result != null) preparation = result
                if (unauthorized) { authFailure = true; player.pause() }
                publish()
                if (shouldPoll()) main.postDelayed(poll, 1000)
            }
        }
    }
    @Synchronized fun manualRetry() { if (key.isNotEmpty()) { retry.retry(); serial++; requestId?.let(connection::cancel); requestId = null; preparation = null; main.removeCallbacks(poll); publish(); if (requestId == null) main.post(poll) } }
    @Synchronized fun canPrepare(): Boolean = key.isEmpty() || retry.remaining() == 0L
    fun policy(sourceKey: String, generation: Long) = object : DefaultLoadErrorHandlingPolicy(2) {
        override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long = synchronized(this@PreviewProgram) {
            if (sourceKey != key || generation != connection.generation || generation != epoch) return@synchronized C.TIME_UNSET
            val error = generateSequence(info.exception as Throwable) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull() ?: return@synchronized C.TIME_UNSET
            val header = error.headerFields.entries.firstOrNull { it.key.equals("Retry-After", true) }?.value?.firstOrNull()
            val current = retry; val token = serial
            val delay = current.delay(error.responseCode, header)
            main.post { if (serial == token && retry === current) publish() }
            delay ?: C.TIME_UNSET
        }
    }
    @Synchronized fun loaded(sourceKey: String) {
        if (sourceKey != key) return
        val current = retry; val token = serial
        current.loaded(); main.post {
            if (token == serial && current === retry) {
                if (preparationState() == "unavailable") { preparation = null; if (requestId == null) { main.removeCallbacks(poll); main.post(poll) } }
                publish()
            }
        }
    }
    @Synchronized override fun close() { closed = true; clear(); worker.shutdownNow() }
}
