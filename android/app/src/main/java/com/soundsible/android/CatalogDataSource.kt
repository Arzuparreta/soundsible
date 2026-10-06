package com.soundsible.android

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Resolve a retained catalog occurrence when its native source actually opens, never in the WebView. */
@UnstableApi
internal class CatalogDataSource(private val connection: EngineConnection, private val remote: DataSource.Factory,
    private val item: MediaItem, private val resolved: (MediaItem) -> Unit,
    private val cache: ConcurrentHashMap<String, String>) : DataSource {
    private var delegate: DataSource? = null
    private val listeners = mutableListOf<TransferListener>()
    private var epoch = -1L
    private var identity: String? = null
    @Volatile private var requestId: String? = null
    @Volatile private var cancelled = false
    override fun addTransferListener(listener: TransferListener) { listeners.add(listener) }
    override fun open(spec: DataSpec): Long {
        cancelled = false
        epoch = spec.uri.getQueryParameter("android_generation")?.toLongOrNull() ?: -1
        identity = connection.sessionIdentity(epoch)
        val key = item.mediaMetadata.extras?.getString(ProgramQueue.KEY) ?: throw java.io.IOException("CATALOG_OCCURRENCE")
        require(epoch == connection.generation && identity != null && key == spec.uri.getQueryParameter("android_occurrence"))
        val owner = identity
        val reference = item.mediaMetadata.extras?.getString(ProgramQueue.PENDING)?.let(::JSONObject)
        val cacheKey = "$epoch:$owner:$key"
        val video = if (reference == null) item.mediaId else cache[cacheKey] ?: run {
            val body = JSONObject().put("artist", reference.getString("artist")).put("title", reference.getString("title"))
            reference.optDouble("duration", Double.NaN).takeIf { it.isFinite() && it > 0 && it <= 86400 }?.let { body.put("duration", it) }
            val id = "catalog-source-" + java.util.UUID.randomUUID(); requestId = id
            val found = try {
                connection.execute("/api/catalog/resolve", "POST", body.toString().toRequestBody("application/json".toMediaType()), emptyMap(), epoch, id, 30000).use {
                    if (!it.isSuccessful) throw HttpDataSource.InvalidResponseCodeException(it.code, it.message, null, it.headers.toMultimap(), spec, byteArrayOf())
                    val raw = it.peekBody(65537).string(); require(raw.toByteArray().size <= 65536)
                    JSONObject(raw).optString("video_id").also { value -> require(Regex("^[A-Za-z0-9_-]{11}$").matches(value)) { "CATALOG_RECORDING_UNAVAILABLE" } }
                }
            } finally { requestId = null }
            require(!cancelled && epoch == connection.generation && connection.sessionIdentity(epoch) == owner)
            if (cache.size < ProgramQueue.LIMIT) cache[cacheKey] = found
            found
        }
        require(!cancelled && Regex("^[A-Za-z0-9_-]{11}$").matches(video) && epoch == connection.generation && connection.sessionIdentity(epoch) == owner)
        if (reference != null) {
            val extras = android.os.Bundle(item.mediaMetadata.extras).apply { remove(ProgramQueue.PENDING); putString(ProgramQueue.SOURCE, "preview") }
            // Keep this occurrence's alias URI: Media3 can update metadata without replacing its live source.
            resolved(item.buildUpon().setMediaId(video).setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build())
        }
        val uri = Uri.parse(connection.origin + "/api/preview/stream/" + video).buildUpon()
            .appendQueryParameter("android_generation", epoch.toString()).appendQueryParameter("android_occurrence", key).build()
        val source = remote.createDataSource(); listeners.forEach(source::addTransferListener); delegate = source
        return source.open(spec.buildUpon().setUri(uri).build())
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        require(!cancelled && epoch == connection.generation && connection.sessionIdentity(epoch) == identity)
        return delegate!!.read(buffer, offset, length)
    }
    override fun getUri(): Uri? = delegate?.uri
    override fun getResponseHeaders(): Map<String, List<String>> = delegate?.responseHeaders ?: emptyMap()
    override fun close() { cancelled = true; requestId?.let(connection::cancel); delegate?.close(); delegate = null }
}
