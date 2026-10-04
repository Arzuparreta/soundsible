package com.soundsible.android

import android.content.Context
import android.net.Uri
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Opaque, transient OS grants, private to the selected engine generation. */
object ImportFiles {
    data class Source(val token: String, val epoch: Long, val profile: String, val session: String, val name: String, val type: String, val size: Long, val context: Context, val uri: Uri)
    data class Upload(val name: String, val body: ImportStreamBody)
    private class Lease(val source: Source) {
        val valid = AtomicBoolean(true)
        @Volatile var stream: InputStream? = null
        fun cancel() { valid.set(false); try { stream?.close() } catch (_: Exception) {} }
    }
    private val sources = ConcurrentHashMap<String, Source>()
    private val uploads = ConcurrentHashMap<String, Lease>()
    private val timers = ConcurrentHashMap<String, java.util.concurrent.ScheduledFuture<*>>()
    private val clock = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }
    private val attached = java.util.Collections.newSetFromMap(ConcurrentHashMap<EngineConnection, Boolean>())
    fun add(connection: EngineConnection, source: Source) {
        require(source.uri.scheme == "content" && source.epoch == connection.generation && source.size in -1..ImportStreamBody.MAX_BYTES && source.profile == connection.offline.profileKey(source.epoch) && source.session == connection.sessionIdentity(source.epoch))
        if (attached.add(connection)) connection.resetListeners.add({ clear() })
        sources[source.token] = source
        timers[source.token] = clock.schedule({ release(source.token) }, 10, TimeUnit.MINUTES)
    }
    fun claim(connection: EngineConnection, epoch: Long, id: String, token: String): Upload {
        val source = sources.remove(token) ?: error("IMPORT_NOT_SELECTED")
        timers.remove(token)?.cancel(false)
        require(source.epoch == epoch && epoch == connection.generation && connection.cookieHeader(epoch) != null && source.profile == connection.offline.profileKey(epoch) && source.session == connection.sessionIdentity(epoch))
        val lease = Lease(source)
        require(uploads.putIfAbsent(id, lease) == null)
        timers[id] = clock.schedule({ cancel(id) }, 120, TimeUnit.SECONDS)
        val body = ImportStreamBody(
            open = { source.context.contentResolver.openInputStream(source.uri) ?: error("IMPORT_UNAVAILABLE") },
            current = { lease.valid.get() && connection.generation == epoch && source.session == connection.sessionIdentity(epoch) && runCatching { connection.offline.profileKey(epoch) == source.profile }.getOrDefault(false) },
            size = source.size, mime = source.type.toMediaTypeOrNull(),
            observe = { stream -> lease.stream = stream; if (!lease.valid.get()) try { stream?.close() } catch (_: Exception) {} },
        )
        return Upload(source.name, body)
    }
    fun cancel(id: String) { uploads[id]?.cancel() }
    fun finish(id: String) { uploads.remove(id)?.cancel(); timers.remove(id)?.cancel(false) }
    fun release(token: String) { sources.remove(token); timers.remove(token)?.cancel(false) }
    fun clear() {
        uploads.keys.toList().forEach(::finish)
        sources.keys.toList().forEach(::release)
    }
}
