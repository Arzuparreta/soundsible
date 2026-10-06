package com.soundsible.android

import android.content.Context
import android.os.Handler
import androidx.media3.common.util.UnstableApi
import io.socket.client.Manager
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

/** Account-scoped device registration and remote transport belong to the service, not the WebView. */
@UnstableApi
internal class NativeDeviceSession(context: Context, private val connection: EngineConnection,
    private val main: Handler, private val snapshot: () -> JSONObject?,
    private val command: (String, JSONObject) -> Unit, private val publish: (JSONObject) -> Unit) : AutoCloseable {
    private val prefs = context.getSharedPreferences("soundsible-device", Context.MODE_PRIVATE)
    private val appContext = context.applicationContext
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-device-session").apply { isDaemon = true } }
    private var socket: Socket? = null
    private var client: okhttp3.OkHttpClient? = null
    private var epoch = -1L
    private var identity: String? = null
    private var profile: String? = null
    private var deviceId: String? = null
    private var serial = 0L
    private var authRequest: String? = null
    private var stateRequest: String? = null
    @Volatile private var handoffRequest: String? = null
    private var handoffFuture: com.google.common.util.concurrent.SettableFuture<androidx.media3.session.SessionResult>? = null
    private var retryAfter = 0L
    private var rejectedIdentity: String? = null
    private var connecting = false
    private var publishing = false
    private var dirty = false
    private var lastBody: String? = null
    private var hadTrack = false
    private var lastPositionPing = 0L
    private var stateRetryAfter = 0L
    @Volatile private var closed = false
    private val resetListener: () -> Unit = { main.post { reset() } }
    private val tick = object : Runnable {
        override fun run() {
            if (closed) return
            if (!owns()) { reset(); connect() }
            else if (socket?.connected() == true) report()
            main.postDelayed(this, 2000)
        }
    }
    init { connection.resetListeners.add(resetListener); main.post(tick) }
    private fun owns(): Boolean = !closed && identity != null && epoch == connection.generation &&
        runCatching { connection.sessionIdentity(epoch) == identity && connection.offline.profileKey(epoch) == profile }.getOrDefault(false)
    fun name(): String = DeviceName.get(appContext)
    /** A per-install name; a connected session re-registers at once so peers and Core see it without reconnecting. */
    fun rename(value: String): Boolean {
        if (!DeviceName.set(appContext, value)) return false
        if (owns() && socket?.connected() == true) { socket?.emit("playback_register", registration()); changed() } else publish(state())
        return true
    }
    fun state(): JSONObject = JSONObject().put("generation", connection.generation).put("device_name", name())
        .put("device_id", if (owns()) deviceId else JSONObject.NULL).put("connected", owns() && socket?.connected() == true)
        .put("retrying", retryAfter > android.os.SystemClock.elapsedRealtime())
        .put("can_handoff", owns() && socket?.connected() == true && handoffFuture == null && snapshot() != null)
    private fun connect() {
        if (closed || connecting || android.os.SystemClock.elapsedRealtime() < retryAfter) return
        val generation = connection.generation
        val cookieIdentity = runCatching { connection.sessionIdentity(generation) }.getOrNull() ?: return
        if (cookieIdentity == rejectedIdentity) return
        val owner = runCatching { connection.offline.profileKey(generation) }.getOrNull() ?: return
        epoch = generation; identity = cookieIdentity; profile = owner
        val key = java.security.MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString("") { "%02x".format(it) }
        deviceId = prefs.getString(key, null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit().putString(key, it).apply() }
        connecting = true
        val token = ++serial
        val requestId = "device-auth-" + java.util.UUID.randomUUID()
        authRequest = requestId
        publish(state())
        worker.execute {
            // A cached offline profile does not authorize a new Core socket. Verify the cookie without purging offline music.
            var denied = false
            val valid = runCatching {
                connection.execute("/api/auth/state", "GET", null, emptyMap(), generation, requestId, 8000).use {
                    val ownerMatches = it.isSuccessful && it.peekBody(65536).string().let { body -> JSONObject(body).optJSONObject("user")?.optString("id") == owner.substringAfterLast('|') }
                    denied = it.code == 401 || it.code == 403 || it.isSuccessful && !ownerMatches
                    ownerMatches
                }
            }.getOrDefault(false)
            main.post {
                if (token != serial) return@post
                connecting = false; authRequest = null
                if (!owns() || epoch != generation || profile != owner) return@post
                if (!valid) { identity = null; retryAfter = android.os.SystemClock.elapsedRealtime() + 8000
                    if (denied) rejectedIdentity = cookieIdentity
                    publish(state()); return@post }
                try {
                    val transport = connection.client
                    client = transport
                    val options = IO.Options().apply {
                        forceNew = true; reconnection = true; reconnectionAttempts = 5
                        reconnectionDelay = 1000; reconnectionDelayMax = 5000; timeout = 8000
                        callFactory = transport; webSocketFactory = transport
                        extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(generation)!!))
                    }
                    val next = IO.socket(connection.origin, options); socket = next
                    next.on(Socket.EVENT_CONNECT) { main.post {
                        if (owns() && socket === next) {
                            next.emit("playback_register", registration()); publish(state()); changed()
                        }
                    } }
                    next.io().on(Manager.EVENT_RECONNECT_FAILED) { main.post {
                        if (owns() && socket === next) {
                            retryAfter = android.os.SystemClock.elapsedRealtime() + 30000
                            reset() // Release this exhausted manager; tick starts a verified one after cooldown.
                        }
                    } }
                    for (event in listOf(Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR)) next.on(event) { main.post {
                        if (owns() && socket === next) publish(state())
                    } }
                    for (event in listOf("playback_stop_requested", "playback_start_requested", "playback_next_requested", "playback_previous_requested", "playback_seek_requested")) {
                        next.on(event) { arguments ->
                            val payload = (arguments.firstOrNull() as? JSONObject) ?: JSONObject()
                            if (payload.toString().length <= 256 * 1024) main.post {
                                if (owns() && socket === next) { runCatching { command(event, payload) }; changed() }
                            }
                        }
                    }
                    next.connect()
                } catch (_: Exception) { reset() }
            }
        }
    }
    private fun registration() = JSONObject().put("device_id", deviceId).put("device_name", name()).put("device_type", "android")
    fun changed() { dirty = true; publish(state()); report() }
    private fun report() {
        if (!owns() || socket?.connected() != true || publishing || handoffFuture != null) return
        val body = snapshot() ?: if (hadTrack) JSONObject().put("track_id", JSONObject.NULL).put("track", JSONObject.NULL)
            .put("position_sec", 0).put("is_playing", false).put("session", JSONObject.NULL) else return
        val now = android.os.SystemClock.elapsedRealtime()
        if (now < stateRetryAfter) return
        val content = body.toString()
        if (!dirty && content == lastBody && (!body.optBoolean("is_playing") || now - lastPositionPing < 15000)) return
        // Position advances continuously; throttle periodic updates but publish actual transport/queue changes immediately.
        if (!dirty && now - lastPositionPing < 15000) return
        body.put("device_id", deviceId).put("device_name", name()).put("device_type", "android")
        val generation = epoch; val owner = identity; val token = serial
        val requestId = "device-state-" + java.util.UUID.randomUUID()
        stateRequest = requestId
        publishing = true; dirty = false
        worker.execute {
            val success = runCatching {
                connection.execute("/api/playback/state", "PUT", body.toString().toRequestBody("application/json".toMediaType()), emptyMap(), generation,
                    requestId, 8000).use { it.isSuccessful }
            }.getOrDefault(false)
            main.post {
                if (token != serial) return@post
                publishing = false; stateRequest = null
                if (owns() && generation == epoch && owner == identity) {
                    if (success) { lastBody = content; lastPositionPing = now; hadTrack = !body.isNull("track_id"); stateRetryAfter = 0 }
                    else { dirty = true; stateRetryAfter = android.os.SystemClock.elapsedRealtime() + 8000 }
                    if (dirty) report()
                }
            }
        }
    }
    /** Publish fresh native state before Core stops this device and starts its peer. */
    fun handoff(target: String): com.google.common.util.concurrent.ListenableFuture<androidx.media3.session.SessionResult> {
        val future = com.google.common.util.concurrent.SettableFuture.create<androidx.media3.session.SessionResult>()
        val initial = snapshot()
        if (!owns() || socket?.connected() != true || handoffFuture != null || initial == null || target == deviceId ||
            target.isBlank() || target.length > 128) {
            future.set(androidx.media3.session.SessionResult(androidx.media3.session.SessionError.ERROR_BAD_VALUE)); return future
        }
        val token = serial; val generation = epoch
        fun signature(body: JSONObject) = JSONObject(body.toString()).apply { remove("position_sec") }.toString()
        val source = signature(initial)
        fun valid() = owns() && serial == token && handoffFuture === future
        fun unchanged() = valid() && snapshot()?.let { signature(it) == source } == true
        fun finish(success: Boolean) {
            if (handoffFuture !== future) return
            handoffFuture = null; handoffRequest = null
            future.set(androidx.media3.session.SessionResult(if (success) androidx.media3.session.SessionResult.RESULT_SUCCESS else androidx.media3.session.SessionError.ERROR_IO))
            publish(state()); dirty = true; report()
        }
        fun request(path: String, method: String, body: JSONObject? = null): JSONObject {
            val id = "device-handoff-" + java.util.UUID.randomUUID()
            handoffRequest = id
            return connection.execute(path, method, body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), generation, id, 8000).use {
                require(it.isSuccessful)
                val text = it.peekBody(256 * 1024L).string()
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        }
        handoffFuture = future; publish(state())
        worker.execute {
            val ready = runCatching {
                val devices = request("/api/devices", "GET").getJSONArray("devices")
                (0 until devices.length()).any { devices.getJSONObject(it).let { row -> row.optString("device_id") == target && row.optBoolean("socket_active") } }
            }.getOrDefault(false)
            main.post {
                if (!unchanged() || !ready) { finish(false); return@post }
                val body = snapshot()!!.put("device_id", deviceId).put("device_name", name()).put("device_type", "android")
                worker.execute {
                    val stored = runCatching { request("/api/playback/state", "PUT", body); true }.getOrDefault(false)
                    main.post {
                        if (!unchanged() || !stored) { finish(false); return@post }
                        worker.execute {
                            val sent = runCatching { request("/api/playback/handoff", "POST", JSONObject().put("from_device_id", deviceId).put("to_device_id", target)); true }.getOrDefault(false)
                            main.post { if (valid()) finish(sent) }
                        }
                    }
                }
            }
        }
        return future
    }
    private fun reset() {
        socket?.io()?.off(); socket?.off(); socket?.disconnect(); socket = null
        val previous = client; client = null
        if (previous != null && !worker.isShutdown) worker.execute {
            previous.dispatcher.cancelAll(); previous.connectionPool.evictAll(); previous.dispatcher.executorService.shutdown()
        }
        handoffRequest?.let(connection::cancel); handoffRequest = null
        handoffFuture?.set(androidx.media3.session.SessionResult(androidx.media3.session.SessionError.ERROR_SESSION_DISCONNECTED)); handoffFuture = null
        serial++; connecting = false; publishing = false
        authRequest?.let(connection::cancel); stateRequest?.let(connection::cancel); authRequest = null; stateRequest = null
        epoch = -1; identity = null; profile = null; deviceId = null; lastBody = null; hadTrack = false; lastPositionPing = 0; stateRetryAfter = 0; dirty = false
        publish(state())
    }
    override fun close() {
        if (closed) return
        closed = true; main.removeCallbacks(tick); connection.resetListeners.remove(resetListener); reset(); worker.shutdown()
    }
}
