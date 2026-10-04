package com.soundsible.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import okhttp3.Call
import okhttp3.Request
import java.io.ByteArrayOutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Private, generation-bound artwork. No public fetch fallback or disk cache or cache across accounts. */
@UnstableApi
class ProgramArtwork(private val connection: EngineConnection) : BitmapLoader, AutoCloseable {
    companion object {
        const val MAX_BYTES = 2 * 1024 * 1024
        const val MAX_PIXELS = 16L * 1024 * 1024
        const val MAX_EDGE = 512
        @JvmOverloads fun uri(epoch: Long, id: String, revision: String? = null): Uri = Uri.Builder().scheme("soundsible-artwork")
            .authority(epoch.toString()).appendPath(id).apply { if (revision != null) { require(Regex("^[a-f0-9-]{36}$").matches(revision)); appendQueryParameter("revision", revision) } }.build()
    }
    private val lock = Any()
    private val executor = ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(16))
    private val jobs = mutableMapOf<SettableFuture<Bitmap>, Call?>()
    private var last: Pair<Uri, ListenableFuture<Bitmap>>? = null
    private var closed = false
    private val reset: () -> Unit = { synchronized(lock) {
        last = null
        jobs.keys.toList().forEach { it.cancel(true) }
        jobs.values.toList().forEach { it?.cancel() }
        jobs.clear()
    } }
    init { connection.resetListeners.add(reset) }
    override fun supportsMimeType(mimeType: String): Boolean = mimeType in setOf("image/png", "image/jpeg", "image/webp")
    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = submit(connection.generation) { decode(data) }
    override fun loadBitmapFromMetadata(metadata: androidx.media3.common.MediaMetadata): ListenableFuture<Bitmap>? {
        // Sidecars override embedded art without rewriting the audio file.
        // An expired private URI must fail rather than expose stale embedded art.
        val uri = metadata.artworkUri
        if (uri?.scheme == "soundsible-artwork") return loadBitmap(uri)
        return metadata.artworkData?.let(::decodeBitmap) ?: uri?.let(::loadBitmap)
    }
    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = synchronized(lock) {
        last?.takeIf { uri.authority == connection.generation.toString() && it.first == uri && !it.second.isCancelled }?.let { return@synchronized it.second }
        val epoch = uri.authority?.toLongOrNull() ?: -1
        val id = uri.pathSegments.singleOrNull() ?: ""
        val result = submit(epoch) { future ->
            val validRevision = uri.query == null || (uri.queryParameterNames == setOf("revision") && uri.getQueryParameters("revision").size == 1 && Regex("^[a-f0-9-]{36}$").matches(uri.getQueryParameter("revision") ?: ""))
            require(uri.scheme == "soundsible-artwork" && validRevision && uri.fragment == null && id.isNotBlank() && id.length <= 512)
            val selected = connection.origin
            val cookie = connection.cookieHeader(epoch) ?: error("NO_SESSION")
            val client = connection.client.newBuilder().retryOnConnectionFailure(false).callTimeout(8, TimeUnit.SECONDS).build()
            val call = client.newCall(Request.Builder().url(selected + "/api/static/cover/" + Uri.encode(id) + "?size=thumb")
                .header("Cookie", cookie).build())
            synchronized(lock) {
                require(!future.isCancelled && epoch == connection.generation && selected == connection.origin)
                jobs[future] = call
            }
            call.execute().use { response ->
                require(response.code == 200 && supportsMimeType(response.header("Content-Type", "")!!.substringBefore(';')))
                val body = response.body ?: error("NO_IMAGE")
                require(body.contentLength() <= MAX_BYTES)
                val output = ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                body.byteStream().use { input ->
                    while (true) {
                        val count = input.read(chunk)
                        if (count < 0) break
                        require(output.size() + count <= MAX_BYTES && epoch == connection.generation && !future.isCancelled)
                        output.write(chunk, 0, count)
                    }
                }
                require(epoch == connection.generation && selected == connection.origin)
                decode(output.toByteArray())
            }
        }
        // Only the last native request is retained, including duplicates; reset discards it.
        last = uri to result
        result.addListener({ synchronized(lock) { if (last?.second === result) { try { result.get() } catch (_: Exception) { last = null } } } }, Runnable::run)
        result
    }
    private fun submit(epoch: Long, work: (SettableFuture<Bitmap>) -> Bitmap): ListenableFuture<Bitmap> {
        val future = SettableFuture.create<Bitmap>()
        synchronized(lock) {
            if (closed || epoch != connection.generation) { future.setException(IllegalStateException("STALE_SESSION")); return future }
            jobs[future] = null
            future.addListener({ if (future.isCancelled) synchronized(lock) { jobs[future]?.cancel() } }, Runnable::run)
            try {
                executor.execute {
                    try {
                        require(!future.isCancelled && epoch == connection.generation)
                        val bitmap = work(future)
                        synchronized(lock) { if (closed || future.isCancelled || epoch != connection.generation) bitmap.recycle() else future.set(bitmap) }
                    } catch (error: Exception) { future.setException(error) }
                    finally { synchronized(lock) { jobs.remove(future) } }
                }
            } catch (error: java.util.concurrent.RejectedExecutionException) { jobs.remove(future); future.setException(error) }
        }
        return future
    }
    private fun decode(bytes: ByteArray): Bitmap {
        require(bytes.size <= MAX_BYTES)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= MAX_PIXELS)
        var sample = 1
        while (bounds.outWidth / sample > MAX_EDGE || bounds.outHeight / sample > MAX_EDGE) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("INVALID_IMAGE")
    }
    fun clear() { reset() }
    override fun close() {
        connection.resetListeners.remove(reset)
        synchronized(lock) { closed = true; reset() }
        executor.shutdownNow()
    }
}
