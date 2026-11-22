package com.soundsible.android

import android.content.Context
import android.os.Handler
import android.os.SystemClock
import androidx.media3.common.util.UnstableApi
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Manager
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Account-scoped device registration and remote transport belong to the service, not the WebView. */
@UnstableApi
internal class NativeDeviceSession(
    context: Context,
    private val connection: EngineConnection,
    private val main: Handler,
    private val snapshot: () -> JSONObject?,
    private val command: (String, JSONObject, (String?) -> Unit) -> Unit,
    private val publish: (JSONObject) -> Unit,
) : AutoCloseable {
    private val prefs = context.getSharedPreferences("soundsible-device", Context.MODE_PRIVATE)
    private val appContext = context.applicationContext
    private val instanceId = java.util.UUID.randomUUID().toString()
    // Keep transfer HTTP off the publication thread: POST /api/devices/transfer calls back into
    // session.release on this socket, which must publish state before the transfer call returns.
    private val publishWorker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-device-publish").apply { isDaemon = true } }
    private val handoffWorker = Executors.newSingleThreadExecutor { task -> Thread(task, "soundsible-device-handoff").apply { isDaemon = true } }
    private var socket: Socket? = null
    private var client: okhttp3.OkHttpClient? = null
    private var epoch = -1L
    private var identity: String? = null
    private var profile: String? = null
    private var deviceId: String? = null
    private var serial = 0L
    private var seq = 0L
    private var lastRev: Long? = null
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
    private var activePublishWaiters = mutableListOf<(Long?) -> Unit>()
    private var nextPublishWaiters = mutableListOf<(Long?) -> Unit>()
    @Volatile private var closed = false
    private val resetListener: () -> Unit = { main.post { reset() } }
    private val debouncedReport = Runnable { if (!closed) report() }
    private val tick = object : Runnable {
        override fun run() {
            if (closed) return
            if (!owns()) { reset(); connect() }
            else if (socket?.connected() == true) report()
            main.postDelayed(this, 2000)
        }
    }
    init { connection.resetListeners.add(resetListener); main.post(tick) }

    /** Debug delivery phases only: never log account, device, media or exception messages. */
    private fun diagnostic(phase: String, event: String = "", failure: Throwable? = null) {
        if (!BuildConfig.DEBUG) return
        val frame = failure?.stackTrace?.firstOrNull { it.className.startsWith("com.soundsible.android.") }
        val sessionMatches = runCatching { identity != null && connection.sessionIdentity(epoch) == identity }.getOrDefault(false)
        val profileMatches = runCatching { profile != null && connection.offline.profileKey(epoch) == profile }.getOrDefault(false)
        val returnedQueue = if (phase == "command_returned") runCatching {
            val body = snapshot()
            body?.optJSONObject("session")?.optJSONArray("queue")?.length() ?: if (body?.isNull("track_id") == false) 1 else 0
        }.getOrDefault(-1) else null
        val message = "phase=$phase event=$event generation=${connection.generation} epoch=$epoch serial=$serial" +
            " owns=${owns()} sessionMatches=$sessionMatches profileMatches=$profileMatches connected=${socket?.connected() == true}" +
            (if (returnedQueue == null) "" else " snapshotQueue=$returnedQueue") +
            (if (failure == null) "" else " failure=${failure.javaClass.simpleName} frame=${frame?.className}:${frame?.lineNumber}")
        if (failure == null) android.util.Log.d("DeviceSessionDelivery", message) else android.util.Log.w("DeviceSessionDelivery", message)
    }

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
        .put("retrying", retryAfter > SystemClock.elapsedRealtime())
        .put("can_handoff", owns() && socket?.connected() == true && handoffFuture == null && snapshot() != null)

    private fun connect() {
        if (closed || connecting || SystemClock.elapsedRealtime() < retryAfter) return
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
        publishWorker.execute {
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
                if (!valid) {
                    identity = null; retryAfter = SystemClock.elapsedRealtime() + 8000
                    if (denied) rejectedIdentity = cookieIdentity
                    publish(state()); return@post
                }
                try {
                    // This socket owner cancels/shuts down its transport on close;
                    // do not let that lifecycle retire the shared REST pool.
                    val transport = connection.client.newBuilder().dispatcher(okhttp3.Dispatcher())
                        .connectionPool(okhttp3.ConnectionPool()).build()
                    client = transport
                    val options = IO.Options().apply {
                        forceNew = true; reconnection = true; reconnectionAttempts = 5
                        reconnectionDelay = 1000; reconnectionDelayMax = 5000; timeout = 8000
                        callFactory = SocketIoCallFactory(transport); webSocketFactory = transport
                        extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(generation)!!))
                    }
                    val next = IO.socket(connection.origin, options); socket = next
                    next.on(Socket.EVENT_CONNECT) { main.post {
                        if (owns() && socket === next) {
                            next.emit("playback_register", registration()); diagnostic("registration_emitted"); publish(state()); changed()
                        }
                    } }
                    next.io().on(Manager.EVENT_RECONNECT_FAILED) { main.post {
                        if (owns() && socket === next) {
                            retryAfter = SystemClock.elapsedRealtime() + 30000
                            reset() // Release this exhausted manager; tick starts a verified one after cooldown.
                        }
                    } }
                    for (event in listOf(Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR)) next.on(event) { main.post {
                        if (owns() && socket === next) { diagnostic("transport", event); publish(state()) }
                    } }
                    next.on("device_command") { arguments ->
                        handleDeviceCommand(next, arguments)
                    }
                    next.connect()
                } catch (_: Exception) { reset() }
            }
        }
    }

    private fun handleDeviceCommand(ownerSocket: Socket, arguments: Array<out Any?>) {
        val ack = arguments.lastOrNull() as? Ack
        val payload = arguments.firstOrNull() as? JSONObject
        val replied = AtomicBoolean(false)
        fun respond(body: JSONObject) {
            if (replied.compareAndSet(false, true)) ack?.call(body)
        }
        if (payload == null || payload.toString().length > 320 * 1024) {
            respond(RemoteCommandLogic.ackRejected("invalid"))
            return
        }
        main.post {
            val name = payload.optString("name")
            val args = payload.optJSONObject("args") ?: JSONObject()
            diagnostic("received", name)
            if (!owns() || socket !== ownerSocket) {
                diagnostic("obsolete_socket", name)
                respond(RemoteCommandLogic.ackRejected("invalid_state"))
                return@post
            }
            if (name !in RemoteCommandLogic.supportedCommands) {
                respond(RemoteCommandLogic.ackRejected("unsupported"))
                return@post
            }
            if (name == "session.export") {
                val exported = exportState()
                if (exported == null) respond(RemoteCommandLogic.ackRejected("nothing_playing"))
                else respond(RemoteCommandLogic.ackApplied(state = exported))
                return@post
            }
            val token = serial
            val startedAt = SystemClock.elapsedRealtime()
            val deadlineMs = if (name == "session.import") 8800L else 4500L
            val guard = Runnable {
                diagnostic("command_timeout", name)
                respond(RemoteCommandLogic.ackRejected("invalid_state"))
            }
            main.postDelayed(guard, deadlineMs)
            fun finish(body: JSONObject) {
                main.removeCallbacks(guard)
                respond(body)
            }
            try {
                command(name, args) { rejection ->
                    if (replied.get()) return@command
                    if (token != serial || !owns() || socket !== ownerSocket) {
                        finish(RemoteCommandLogic.ackRejected("invalid_state"))
                        return@command
                    }
                    if (rejection != null) {
                        diagnostic("command_rejected", "$name:$rejection")
                        finish(RemoteCommandLogic.ackRejected(rejection))
                        return@command
                    }
                    diagnostic("command_returned", name)
                    publish(state())
                    val remaining = (deadlineMs - (SystemClock.elapsedRealtime() - startedAt)).coerceAtLeast(250L)
                    publishAndWait(remaining) { rev ->
                        if (rev != null) finish(RemoteCommandLogic.ackApplied(rev = rev))
                        else finish(RemoteCommandLogic.ackRejected("invalid_state"))
                    }
                }
            } catch (failure: RemoteCommandRejected) {
                diagnostic("command_rejected", "$name:${failure.reason}")
                finish(RemoteCommandLogic.ackRejected(failure.reason))
            } catch (failure: Exception) {
                diagnostic("command_failed", name, failure = failure)
                finish(RemoteCommandLogic.ackRejected("invalid_state"))
            }
        }
    }

    private fun exportState(): JSONObject? = snapshot()
        ?.put("device_id", deviceId)
        ?.put("device_name", name())
        ?.put("device_type", "android")
        ?.put("instance_id", instanceId)

    private fun registration() = RemoteCommandLogic.registration(
        deviceId = deviceId!!,
        deviceName = name(),
        instanceId = instanceId,
        smallestScreenWidthDp = appContext.resources.configuration.smallestScreenWidthDp,
    )

    fun changed(immediate: Boolean = true) {
        dirty = true
        publish(state())
        main.removeCallbacks(debouncedReport)
        if (immediate) report() else main.postDelayed(debouncedReport, 100)
    }

    private fun publishAndWait(timeoutMs: Long, onResult: (Long?) -> Unit) {
        if (!owns() || socket?.connected() != true) {
            onResult(null)
            return
        }
        val done = AtomicBoolean(false)
        lateinit var waiter: (Long?) -> Unit
        val timeout = Runnable {
            if (done.compareAndSet(false, true)) {
                nextPublishWaiters.remove(waiter)
                activePublishWaiters.remove(waiter)
                onResult(null)
            }
        }
        waiter = { rev ->
            if (done.compareAndSet(false, true)) {
                main.removeCallbacks(timeout)
                onResult(rev)
            }
        }
        main.postDelayed(timeout, timeoutMs)
        main.removeCallbacks(debouncedReport)
        dirty = true
        stateRetryAfter = 0L
        nextPublishWaiters.add(waiter)
        report(force = true)
    }

    private fun report(force: Boolean = false) {
        if (!owns() || socket?.connected() != true || publishing) return
        val hasWaiters = nextPublishWaiters.isNotEmpty()
        val body = snapshot() ?: if (hadTrack || force || hasWaiters) {
            JSONObject().put("track_id", JSONObject.NULL).put("track", JSONObject.NULL)
                .put("position_sec", 0).put("is_playing", false)
                .put("live", RemoteCommandLogic.idleLive()).put("session", JSONObject.NULL)
        } else return
        val now = SystemClock.elapsedRealtime()
        if (!force && !hasWaiters && now < stateRetryAfter) return
        val content = body.toString()
        if (!force && !hasWaiters && !dirty && content == lastBody && (!body.optBoolean("is_playing") || now - lastPositionPing < 15000)) return
        // Position advances continuously; throttle periodic updates but publish actual transport/queue changes immediately.
        if (!force && !hasWaiters && !dirty && now - lastPositionPing < 15000) return
        val nextSeq = ++seq
        body.put("device_id", deviceId).put("device_name", name()).put("device_type", "android")
            .put("instance_id", instanceId).put("seq", nextSeq)
        val generation = epoch; val owner = identity; val token = serial
        val requestId = "device-state-" + java.util.UUID.randomUUID()
        val waiters = nextPublishWaiters.toList()
        nextPublishWaiters.clear()
        activePublishWaiters = waiters.toMutableList()
        stateRequest = requestId
        publishing = true; dirty = false
        val timeoutMs = if (waiters.isNotEmpty()) 4000L else 8000L
        publishWorker.execute {
            val answer = runCatching {
                connection.execute(
                    "/api/playback/state", "PUT",
                    body.toString().toRequestBody("application/json".toMediaType()),
                    emptyMap(), generation, requestId, timeoutMs,
                ).use { response ->
                    val text = response.peekBody(65536).string()
                    RemoteCommandLogic.parseStatePublishAnswer(response.code, text)
                }
            }.getOrDefault(RemoteCommandLogic.PublishAnswer.Failed)
            main.post {
                if (token != serial) return@post
                publishing = false; stateRequest = null
                val settled = activePublishWaiters.toList()
                activePublishWaiters.clear()
                if (owns() && generation == epoch && owner == identity) {
                    when (answer) {
                        is RemoteCommandLogic.PublishAnswer.Ok -> {
                            lastBody = content
                            lastPositionPing = now
                            hadTrack = !body.isNull("track_id")
                            stateRetryAfter = 0L
                            if (answer.rev != null) lastRev = answer.rev
                            val resolvedRev = answer.rev ?: lastRev ?: 0L
                            settled.forEach { it(resolvedRev) }
                        }
                        RemoteCommandLogic.PublishAnswer.Stale -> {
                            settled.forEach { it(lastRev ?: 0L) }
                        }
                        RemoteCommandLogic.PublishAnswer.Failed -> {
                            dirty = true
                            stateRetryAfter = SystemClock.elapsedRealtime() + 8000
                            settled.forEach { it(null) }
                        }
                    }
                    if (dirty || nextPublishWaiters.isNotEmpty()) report(force = nextPublishWaiters.isNotEmpty())
                } else {
                    settled.forEach { it(null) }
                }
            }
        }
    }

    /** Transfer this device's playback to another device through the engine's transfer pipeline. */
    fun handoff(target: String): com.google.common.util.concurrent.ListenableFuture<androidx.media3.session.SessionResult> {
        val future = com.google.common.util.concurrent.SettableFuture.create<androidx.media3.session.SessionResult>()
        val fromId = deviceId
        if (!owns() || socket?.connected() != true || handoffFuture != null || fromId == null || snapshot() == null ||
            target == fromId || target.isBlank() || target.length > 128) {
            future.set(androidx.media3.session.SessionResult(androidx.media3.session.SessionError.ERROR_BAD_VALUE))
            return future
        }
        val token = serial; val generation = epoch
        val requestId = "device-handoff-" + java.util.UUID.randomUUID()
        handoffRequest = requestId
        handoffFuture = future
        publish(state())
        handoffWorker.execute {
            val ok = runCatching {
                connection.execute(
                    "/api/devices/transfer", "POST",
                    JSONObject().put("from_device_id", fromId).put("to_device_id", target).toString()
                        .toRequestBody("application/json".toMediaType()),
                    emptyMap(), generation, requestId, 18000,
                ).use { response ->
                    RemoteCommandLogic.parseTransferOutcome(response.code, response.peekBody(65536).string())
                }
            }.getOrDefault(false)
            main.post {
                if (token != serial || handoffFuture !== future) return@post
                handoffFuture = null; handoffRequest = null
                future.set(androidx.media3.session.SessionResult(if (ok) androidx.media3.session.SessionResult.RESULT_SUCCESS else androidx.media3.session.SessionError.ERROR_IO))
                publish(state()); dirty = true; report()
            }
        }
        return future
    }

    private fun reset() {
        diagnostic("reset")
        main.removeCallbacks(debouncedReport)
        socket?.io()?.off(); socket?.off(); socket?.disconnect(); socket = null
        val previous = client; client = null
        if (previous != null && !publishWorker.isShutdown) publishWorker.execute {
            previous.dispatcher.cancelAll(); previous.connectionPool.evictAll(); previous.dispatcher.executorService.shutdown()
        }
        handoffRequest?.let(connection::cancel); handoffRequest = null
        handoffFuture?.set(androidx.media3.session.SessionResult(androidx.media3.session.SessionError.ERROR_SESSION_DISCONNECTED)); handoffFuture = null
        val droppedWaiters = activePublishWaiters + nextPublishWaiters
        activePublishWaiters.clear(); nextPublishWaiters.clear()
        droppedWaiters.forEach { it(null) }
        serial++; connecting = false; publishing = false
        authRequest?.let(connection::cancel); stateRequest?.let(connection::cancel); authRequest = null; stateRequest = null
        epoch = -1; identity = null; profile = null; deviceId = null; lastBody = null; hadTrack = false; lastPositionPing = 0; stateRetryAfter = 0; dirty = false; lastRev = null
        publish(state())
    }

    override fun close() {
        if (closed) return
        closed = true
        main.removeCallbacks(tick)
        main.removeCallbacks(debouncedReport)
        connection.resetListeners.remove(resetListener)
        reset()
        publishWorker.shutdown()
        handoffWorker.shutdown()
    }
}
