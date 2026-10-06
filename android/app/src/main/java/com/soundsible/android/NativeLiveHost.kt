package com.soundsible.android

import android.content.Context
import android.os.Bundle
import android.os.Handler
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONArray
import org.webrtc.PeerConnection
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** PlaybackService owns the publisher and room heartbeat; no Activity or JS timers. */
@UnstableApi
internal class NativeLiveHost(
    private val context: Context,
    private val connection: EngineConnection,
    private val main: Handler,
    private val player: () -> Player,
    private val publish: (JSONObject) -> Unit,
) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-live-host").apply { isDaemon = true } }
    private val revision = AtomicLong()
    @Volatile private var closed = false
    @Volatile private var starting = false
    @Volatile private var connected = false
    @Volatile private var room: JSONObject? = null
    @Volatile private var epoch = -1L
    private var peer: LivePeer? = null
    private var socket: Socket? = null
    private var transport: OkHttpClient? = null
    private var messages = JSONArray()
    private var programme: JSONObject? = null
    private var sequence = 0L
    private var pausedSince: Long? = null
    private val tick = object : Runnable {
        override fun run() {
            if (closed || room == null || epoch != connection.generation) return
            if (connected && socket?.connected() == true) {
                val active = player()
                val now = System.currentTimeMillis()
                if (active.isPlaying) pausedSince = null else if (pausedSince == null) pausedSince = now
                val item = active.currentMediaItem
                val primary = item?.let {
                    JSONObject().put("id", it.mediaId.removePrefix("soundsible:track:"))
                        .put("title", it.mediaMetadata.title?.toString().orEmpty())
                        .put("artist", it.mediaMetadata.artist?.toString().orEmpty())
                        .put("artwork_url", JSONObject.NULL)
                        .put("position", active.currentPosition / 1000.0)
                        .put("duration", active.duration.coerceAtLeast(0) / 1000.0).put("gain", 1.0)
                }
                val nextProgram = JSONObject().put("v", 1).put("seq", ++sequence).put("emitted_at", now)
                    .put("program_time", android.os.SystemClock.elapsedRealtime() / 1000.0)
                    .put("transport", if (active.isPlaying) "playing" else "paused")
                    .put("paused_since", pausedSince ?: JSONObject.NULL).put("primary", primary ?: JSONObject.NULL)
                    .put("secondary", JSONObject.NULL).put("transition", JSONObject.NULL)
                programme = nextProgram
                socket?.emit("program_event", nextProgram)
                publish(snapshot())
            }
            main.postDelayed(this, 1000)
        }
    }
    private val reset: () -> Unit = { main.post { stop(false) } }
    init { connection.resetListeners.add(reset) }
    private fun current(token: Long) = !closed && revision.get() == token && epoch == connection.generation
    private fun core(path: String, method: String, body: JSONObject? = null): JSONObject =
        connection.execute(path, method, body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-host-${System.nanoTime()}", 15000).use {
            check(it.isSuccessful) { "LIVE_CORE_${it.code}" }
            val text = it.body?.string().orEmpty()
            if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    private fun publicRoom(value: JSONObject): JSONObject = JSONObject(value.toString()).apply {
        for (key in listOf("host_token", "publish_token", "whip_url", "socket_url", "stream_path")) remove(key)
    }
    fun snapshot(): JSONObject = JSONObject().put("session", room?.let(::publicRoom) ?: JSONObject.NULL)
        .put("connected", connected).put("generation", epoch).put("messages", messages).put("program", programme ?: JSONObject.NULL)

    /** On player looper. Credentials remain inside the service. */
    fun start(title: String): ListenableFuture<SessionResult> {
        if (closed || starting || room != null) return com.google.common.util.concurrent.Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
        starting = true
        val token = revision.incrementAndGet()
        epoch = connection.generation
        val result = SettableFuture.create<SessionResult>()
        worker.execute {
            try {
                val config = core("/api/community/config", "GET")
                require(config.optString("state") == "available") { "LIVE_UNAVAILABLE" }
                val created = core("/api/community/sessions", "POST", JSONObject().put("title", title.take(160))).getJSONObject("session")
                room = created
                check(current(token)) { "STALE_LIVE" }
                val endpoint = created.getString("socket_url").toHttpUrl()
                require(endpoint.isHttps && endpoint.username.isEmpty() && endpoint.password.isEmpty())
                val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                    .callTimeout(20, TimeUnit.SECONDS).addInterceptor { chain ->
                        val url = chain.request().url
                        if (url.scheme != endpoint.scheme || url.host != endpoint.host || url.port != endpoint.port) throw java.io.IOException("LIVE_SOCKET_ORIGIN")
                        chain.proceed(chain.request())
                    }.build()
                transport = client
                val options = IO.Options().apply {
                    forceNew = true; reconnection = true; reconnectionAttempts = 4
                    reconnectionDelay = 500; reconnectionDelayMax = 4000; timeout = 8000
                    callFactory = client; webSocketFactory = client
                    auth = mapOf("session_id" to created.getString("id"), "host_token" to created.getString("host_token"))
                }
                val next = IO.socket(endpoint.toString(), options)
                socket = next
                next.on(Socket.EVENT_CONNECT) { main.post { if (current(token)) { main.removeCallbacks(tick); main.post(tick) } } }
                for (event in listOf("session_snapshot", "session_updated")) next.on(event) { arguments ->
                    val update = (arguments.firstOrNull() as? JSONObject)?.optJSONObject("session")
                    main.post {
                        if (current(token) && update?.optString("id") == room?.optString("id")) {
                            room = JSONObject(room!!.toString()).apply {
                                for (key in listOf("title", "status", "listener_count", "updated_at")) if (update!!.has(key)) put(key, update.get(key))
                            }
                            publish(snapshot())
                        }
                    }
                }
                next.on("presence") { arguments ->
                    val update = arguments.firstOrNull() as? JSONObject
                    main.post { if (current(token) && update?.optString("session_id") == room?.optString("id")) {
                        room = JSONObject(room!!.toString()).put("listener_count", update!!.optInt("listener_count")); publish(snapshot())
                    } }
                }
                next.on("chat_message") { arguments ->
                    val message = arguments.firstOrNull() as? JSONObject
                    main.post { if (current(token) && message?.optString("session_id") == room?.optString("id") && message!!.toString().length <= 4096) {
                        val retained = JSONArray()
                        for (index in maxOf(0, messages.length() - 99) until messages.length()) retained.put(messages.get(index))
                        retained.put(message); messages = retained; publish(snapshot())
                    } }
                }
                next.on("session_ended") { main.post { if (current(token)) stop(false) } }
                next.connect()
                val publisher = LivePeer(context, connection, created.getString("whip_url"), created.getString("publish_token"), true, { state ->
                    main.post { if (current(token)) { connected = state == PeerConnection.PeerConnectionState.CONNECTED; publish(snapshot()) } }
                })
                peer = publisher
                publisher.start()
                check(current(token)) { "STALE_LIVE" }
                main.post {
                    starting = false
                    if (current(token)) { main.removeCallbacks(tick); main.post(tick); publish(snapshot()); result.set(SessionResult(SessionResult.RESULT_SUCCESS, Bundle().apply { putString("liveSession", publicRoom(created).toString()) })) }
                    else result.set(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                }
            } catch (_: Exception) {
                release(true)
                main.post { starting = false; publish(snapshot()); result.set(SessionResult(SessionError.ERROR_IO)) }
            }
        }
        return result
    }
    fun stop(endRoom: Boolean = true): ListenableFuture<SessionResult> {
        revision.incrementAndGet(); connected = false; main.removeCallbacks(tick)
        val result = SettableFuture.create<SessionResult>()
        worker.execute {
            release(endRoom)
            main.post { publish(snapshot()); result.set(SessionResult(SessionResult.RESULT_SUCCESS)) }
        }
        return result
    }
    fun chat(text: String): ListenableFuture<SessionResult> {
        val clean = text.trim()
        if (closed || room == null || epoch != connection.generation || socket?.connected() != true || clean.isEmpty() || clean.length > 500)
            return com.google.common.util.concurrent.Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
        socket?.emit("chat_message", JSONObject().put("text", clean))
        return com.google.common.util.concurrent.Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
    fun title(value: String): ListenableFuture<SessionResult> {
        val selected = room ?: return com.google.common.util.concurrent.Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
        val token = revision.get()
        val result = SettableFuture.create<SessionResult>()
        worker.execute {
            try {
                check(current(token))
                val updated = core("/api/community/sessions/${selected.getString("id")}", "PATCH", JSONObject().put("title", value.take(160))).getJSONObject("session")
                main.post {
                    if (current(token)) {
                        room = JSONObject(room!!.toString()).put("title", updated.getString("title")); publish(snapshot())
                        result.set(SessionResult(SessionResult.RESULT_SUCCESS))
                    } else result.set(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                }
            } catch (_: Exception) { result.set(SessionResult(SessionError.ERROR_IO)) }
        }
        return result
    }
    private fun release(endRoom: Boolean) {
        socket?.off(); socket?.disconnect(); socket = null
        peer?.close(); peer = null
        val previous = room; room = null; connected = false
        if (endRoom && previous != null && epoch == connection.generation) runCatching { core("/api/community/sessions/${previous.getString("id")}", "DELETE") }
        transport?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() }; transport = null
        sequence = 0; pausedSince = null
        main.post { messages = JSONArray(); programme = null }
    }
    override fun close() {
        if (closed) return
        closed = true; revision.incrementAndGet(); connection.resetListeners.remove(reset); main.removeCallbacks(tick)
        worker.execute { release(true) }; worker.shutdown()
    }
}
