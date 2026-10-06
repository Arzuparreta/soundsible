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
    private val artwork: ProgramArtwork,
    private val djSnapshot: () -> ProgramDjSession.LiveSnapshot? = { null },
    private val publish: (JSONObject) -> Unit,
) : AutoCloseable {
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-live-host").apply { isDaemon = true } }
    private val revision = AtomicLong()
    @Volatile private var closed = false
    @Volatile private var starting = false
    @Volatile private var connected = false
    @Volatile private var room: JSONObject? = null
    @Volatile private var epoch = -1L
    @Volatile private var peer: LivePeer? = null
    private var socket: Socket? = null
    private var transport: OkHttpClient? = null
    private var messages = JSONArray()
    private var programme: JSONObject? = null
    private var sequence = 0L
    private var pausedSince: Long? = null
    private val reconnect = LiveReconnect(main, { !closed && room != null && epoch == connection.generation }, ::retryMedia, { stop(false) })
    private val leaseExpired = Runnable { if (!closed && room != null && socket?.connected() != true) stop(false) }
    private fun publisher(selected: JSONObject, token: Long): LivePeer {
        lateinit var next: LivePeer
        next = LivePeer(context, connection, selected.getString("whip_url"), selected.getString("publish_token"), true, { state -> main.post {
            if (current(token) && peer === next) {
                connected = state == PeerConnection.PeerConnectionState.CONNECTED
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> reconnect.connected()
                    PeerConnection.PeerConnectionState.DISCONNECTED, PeerConnection.PeerConnectionState.FAILED -> reconnect.lost()
                    else -> Unit
                }
                publish(snapshot())
            }
        } })
        return next
    }
    private fun retryMedia() {
        val selected = room ?: return
        val token = revision.get()
        val previous = peer; peer = null; previous?.cancel(); connected = false
        worker.execute {
            previous?.close()
            if (!current(token)) return@execute
            val next = publisher(selected, token); peer = next
            try { check(current(token)); next.start() }
            catch (_: Exception) { main.post { if (current(token) && peer === next) reconnect.lost() } }
        }
    }
    private val artWorker = java.util.concurrent.ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, java.util.concurrent.ArrayBlockingQueue<Runnable>(4))
    private val thumbnails = linkedMapOf<String, String>()
    private val pendingArtwork = mutableSetOf<String>()
    private val artworkFailures = linkedMapOf<String, Long>()
    @Volatile private var publicArtwork: LiveArtwork? = null
    private fun artworkUrl(item: androidx.media3.common.MediaItem): Any {
        val key = item.mediaMetadata.artworkUri?.toString() ?: item.mediaMetadata.artworkData?.contentHashCode()?.toString() ?: return JSONObject.NULL
        thumbnails[key]?.let { return it }
        if ((artworkFailures[key] ?: 0L) > android.os.SystemClock.elapsedRealtime()) return JSONObject.NULL
        if (pendingArtwork.size >= 4 || !pendingArtwork.add(key)) return JSONObject.NULL
        val selected = room ?: return JSONObject.NULL
        val token = revision.get()
        val uploader = publicArtwork ?: return JSONObject.NULL
        val bitmap = artwork.loadBitmapFromMetadata(item.mediaMetadata) ?: run { pendingArtwork.remove(key); return JSONObject.NULL }
        bitmap.addListener({
            if (!current(token)) return@addListener
            try {
                artWorker.execute {
                    val uploaded = runCatching { if (!current(token)) return@execute; uploader.upload(bitmap.get(), selected.getString("host_token"), item.mediaId) }.getOrNull()
                    main.post {
                        if (current(token)) {
                            pendingArtwork.remove(key)
                            if (uploaded != null) { thumbnails[key] = uploaded; while (thumbnails.size > 12) thumbnails.remove(thumbnails.keys.first()) }
                            else { artworkFailures[key] = android.os.SystemClock.elapsedRealtime() + 60000; while (artworkFailures.size > 12) artworkFailures.remove(artworkFailures.keys.first()) }
                        }
                    }
                }
            } catch (_: java.util.concurrent.RejectedExecutionException) { main.post { if (current(token)) pendingArtwork.remove(key) } }
        }, Runnable::run)
        return JSONObject.NULL
    }
    private val tick = object : Runnable {
        override fun run() {
            if (closed || room == null || epoch != connection.generation) return
            if (socket?.connected() == true) {
                val active = player()
                val now = System.currentTimeMillis()
                val item = active.currentMediaItem
                val playing = connected && active.isPlaying && item?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) != "live"
                if (playing) pausedSince = null else if (pausedSince == null) pausedSince = now
                val mix = djSnapshot()
                fun deck(it: androidx.media3.common.MediaItem, position: Long, duration: Long, gain: Double): JSONObject =
                    JSONObject().put("id", it.mediaId.removePrefix("soundsible:track:"))
                        .put("title", it.mediaMetadata.title?.toString().orEmpty())
                        .put("artist", it.mediaMetadata.artist?.toString().orEmpty())
                        .put("artwork_url", artworkUrl(it))
                        .put("position", position / 1000.0)
                        .put("duration", duration.coerceAtLeast(0) / 1000.0).put("gain", gain)
                fun mixedDeck(value: ProgramDjSession.LiveDeck?) = value?.let { deck(it.item, it.positionMs, it.durationMs, it.gain) }
                val primary = if (mix != null) mixedDeck(mix.primary) else item?.takeIf {
                    it.mediaMetadata.extras?.getString(ProgramQueue.SOURCE) != "live"
                }?.let { deck(it, active.currentPosition, active.duration, 1.0) }
                val secondary = if (playing) mixedDeck(mix?.secondary) else null
                val transition = mix?.mix?.takeIf { playing && it.phase != "idle" }?.let {
                    JSONObject().put("technique", it.technique).put("phase", it.phase)
                        .put("progress", it.progress).put("dominant", it.incomingDominant)
                }
                val nextProgram = JSONObject().put("v", 1).put("seq", ++sequence).put("emitted_at", now)
                    .put("program_time", android.os.SystemClock.elapsedRealtime() / 1000.0)
                    .put("transport", if (playing) "playing" else "paused")
                    .put("paused_since", pausedSince ?: JSONObject.NULL).put("primary", primary ?: JSONObject.NULL)
                    .put("secondary", secondary ?: JSONObject.NULL).put("transition", transition ?: JSONObject.NULL)
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
            if (it.code == 401) { connection.clearSession(false); throw NativeLiveAuthenticationExpired() }
            check(it.isSuccessful) { "LIVE_CORE_${it.code}" }
            val text = it.body?.string().orEmpty()
            if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    private fun publicRoom(value: JSONObject): JSONObject = JSONObject(value.toString()).apply {
        for (key in listOf("host_token", "publish_token", "whip_url", "socket_url", "stream_path")) remove(key)
    }
    fun snapshot(): JSONObject = JSONObject().put("session", room?.let(::publicRoom) ?: JSONObject.NULL)
        .put("connected", connected && socket?.connected() == true).put("generation", epoch).put("messages", messages).put("program", programme ?: JSONObject.NULL)

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
                publicArtwork = LiveArtwork(created.getString("socket_url"), created.getString("id"))
                val endpoint = created.getString("socket_url").toHttpUrl()
                require(endpoint.isHttps && endpoint.username.isEmpty() && endpoint.password.isEmpty())
                val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                    .readTimeout(40, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS).addInterceptor { chain ->
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
                next.on(Socket.EVENT_CONNECT) { main.post { if (current(token)) { main.removeCallbacks(leaseExpired); main.removeCallbacks(tick); main.post(tick) } } }
                next.on(Socket.EVENT_DISCONNECT) { main.post { if (current(token)) { main.removeCallbacks(leaseExpired); main.postDelayed(leaseExpired, 10000) } } }
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
                val publisher = publisher(created, token)
                peer = publisher
                check(current(token)) { "STALE_LIVE" }
                publisher.start()
                check(current(token)) { "STALE_LIVE" }
                main.post {
                    starting = false
                    if (current(token)) { main.removeCallbacks(tick); main.post(tick); publish(snapshot()); result.set(SessionResult(SessionResult.RESULT_SUCCESS, Bundle().apply { putString("liveSession", publicRoom(created).toString()) })) }
                    else result.set(SessionResult(SessionError.ERROR_SESSION_DISCONNECTED))
                }
            } catch (error: Exception) {
                release(true)
                main.post { reconnect.cancel(); main.removeCallbacks(leaseExpired); starting = false; publish(snapshot()); result.set(SessionResult(if (error is NativeLiveAuthenticationExpired) SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED else SessionError.ERROR_IO)) }
            }
        }
        return result
    }
    fun stop(endRoom: Boolean = true): ListenableFuture<SessionResult> {
        revision.incrementAndGet(); connected = false; main.removeCallbacks(tick)
        reconnect.cancel(); main.removeCallbacks(leaseExpired)
        peer?.cancel()
        thumbnails.clear(); pendingArtwork.clear(); artworkFailures.clear()
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
            } catch (error: Exception) { result.set(SessionResult(if (error is NativeLiveAuthenticationExpired) SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED else SessionError.ERROR_IO)) }
        }
        return result
    }
    private fun release(endRoom: Boolean) {
        publicArtwork?.close(); publicArtwork = null
        socket?.off(); socket?.disconnect(); socket = null
        peer?.close(); peer = null
        val previous = room; room = null; connected = false
        if (endRoom && previous != null && epoch == connection.generation) runCatching { core("/api/community/sessions/${previous.getString("id")}", "DELETE") }
        transport?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() }; transport = null
        sequence = 0; pausedSince = null
        main.post { messages = JSONArray(); programme = null; thumbnails.clear(); pendingArtwork.clear(); artworkFailures.clear() }
    }
    override fun close() {
        if (closed) return
        closed = true; revision.incrementAndGet(); connection.resetListeners.remove(reset); main.removeCallbacks(tick)
        reconnect.cancel(); main.removeCallbacks(leaseExpired)
        peer?.cancel()
        artWorker.shutdownNow()
        worker.execute { release(true) }; worker.shutdown()
    }
}
