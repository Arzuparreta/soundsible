package com.soundsible.android

import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaSession.ControllerInfo
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.ListenableFuture
import io.socket.client.IO
import io.socket.client.Socket

/** Native car subscriptions survive the WebView; events carry no library payload. */
@UnstableApi
internal class ProgramCarSubscriptions(
    private val connection: EngineConnection,
    private val library: ProgramCarLibrary,
    private val main: Handler,
    private val notify: (ControllerInfo, String, Int, LibraryParams?) -> Unit,
) : AutoCloseable {
    private val subscriptions = linkedMapOf<Pair<ControllerInfo, String>, LibraryParams?>()
    private val pending = mutableMapOf<String, ListenableFuture<*>>()
    private val dirty = mutableSetOf<String>()
    private val queued = linkedSetOf<String>()
    private var socket: Socket? = null
    private var generation = -1L
    private var identity: String? = null
    private var closed = false
    private var observingCopies = false
    private val refresh = Runnable { refreshParents() }
    private val copiesChanged: () -> Unit = {
        main.post {
            if (!current()) { reset(); return@post }
            queued.addAll(subscriptions.keys.map { it.second })
            main.removeCallbacks(refresh); main.postDelayed(refresh, 250)
        }
    }

    fun add(browser: ControllerInfo, parent: String, params: LibraryParams?): Boolean {
        if (closed) return false
        val key = browser to parent
        if (key !in subscriptions && (subscriptions.size >= 64 ||
            parent !in subscriptions.keys.map { it.second } && subscriptions.keys.map { it.second }.distinct().size >= 16)) return false
        subscriptions[key] = params
        if (!observingCopies) { connection.offline.changes.add(copiesChanged); observingCopies = true }
        ensureSocket()
        return true
    }

    fun remove(browser: ControllerInfo, parent: String? = null) {
        subscriptions.keys.removeAll { it.first == browser && (parent == null || it.second == parent) }
        val retained = subscriptions.keys.map { it.second }.toSet()
        pending.keys.toList().filter { it !in retained }.forEach { pending.remove(it)?.cancel(true) }
        dirty.retainAll(retained)
        queued.retainAll(retained)
        if (subscriptions.isEmpty()) reset()
    }

    private fun current(): Boolean = !closed && generation == connection.generation && identity != null &&
        library.accountIdentity(generation) == identity

    private fun ensureSocket() {
        if (socket != null && current()) return
        socket?.off(); socket?.disconnect(); socket = null
        generation = connection.generation
        identity = library.accountIdentity(generation)
        if (identity == null) return
        try {
            val epoch = generation
            val cookie = connection.cookieHeader(epoch) ?: return
            val options = IO.Options().apply {
                forceNew = true; reconnection = true; reconnectionAttempts = 5
                reconnectionDelay = 1000; reconnectionDelayMax = 5000; timeout = 8000
                callFactory = connection.client; webSocketFactory = connection.client
                extraHeaders = mapOf("Cookie" to listOf(cookie))
            }
            val next = IO.socket(connection.origin, options)
            socket = next
            for (event in listOf(Socket.EVENT_CONNECT, "library_updated", "saved_entities_updated", "favourites_updated")) {
                next.on(event) {
                    main.post {
                        if (socket !== next || epoch != generation) return@post
                        if (!current()) { reset(); return@post }
                        // Coalesce bursts, fetch current scoped metadata, then notify.
                        queued.addAll(subscriptions.keys.map { it.second })
                        main.removeCallbacks(refresh); main.postDelayed(refresh, 250)
                    }
                }
            }
            next.connect()
        } catch (_: Exception) { socket?.off(); socket?.disconnect(); socket = null }
    }

    private fun refreshParents() {
        if (!current()) { reset(); return }
        val requested = queued.toList(); queued.clear()
        for (parent in requested) {
            if (subscriptions.keys.none { it.second == parent }) continue
            if (pending.containsKey(parent)) { dirty.add(parent); continue }
            val params = subscriptions.entries.first { it.key.second == parent }.value
            val future = library.children(parent, 0, 200, params)
            pending[parent] = future
            future.addListener({
                main.post {
                    if (pending[parent] !== future) return@post
                    pending.remove(parent)
                    if (!current()) { reset(); return@post }
                    val result = runCatching { future.get() }.getOrNull()
                    if (result?.resultCode == SessionResult.RESULT_SUCCESS ||
                        result?.resultCode == androidx.media3.session.SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED) {
                        subscriptions.toMap().forEach { (key, selected) ->
                            if (key.second == parent) notify(key.first, parent,
                                if (result.resultCode == SessionResult.RESULT_SUCCESS) library.childCount(parent) else 0, selected)
                        }
                    }
                    if (dirty.remove(parent)) { queued.add(parent); main.removeCallbacks(refresh); main.postDelayed(refresh, 250) }
                }
            }, { task -> task.run() })
        }
    }

    fun reset() {
        if (observingCopies) { connection.offline.changes.remove(copiesChanged); observingCopies = false }
        main.removeCallbacks(refresh)
        socket?.off(); socket?.disconnect(); socket = null
        pending.values.toList().forEach { it.cancel(true) }; pending.clear()
        dirty.clear(); queued.clear(); subscriptions.clear(); generation = -1; identity = null
    }

    override fun close() { closed = true; reset() }
}
