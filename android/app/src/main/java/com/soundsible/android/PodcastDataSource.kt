package com.soundsible.android

import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Each new range/open mints a fresh engine token. No provider URL or session cookie leaves the engine. */
@UnstableApi
class PodcastDataSource(private val connection: EngineConnection, private val remote: DataSource.Factory,
                        private val enclosure: String, private val epoch: Long, private val occurrence: String, private val registered: (PodcastDataSource) -> Unit = {}, private val released: () -> Unit = {}) : DataSource {
    @Volatile private var cancelled = false
    fun cancel() { cancelled = true; connection.cancel(requestId) }
    private var delegate: DataSource? = null
    private val listeners = mutableListOf<TransferListener>()
    @Volatile private var requestId = "podcast-peek:" + java.util.UUID.randomUUID()
    override fun addTransferListener(listener: TransferListener) { listeners.add(listener) }
    override fun open(spec: DataSpec): Long {
        require(!cancelled && epoch == connection.generation && connection.cookieHeader(epoch) != null)
        requestId = "podcast-peek:" + java.util.UUID.randomUUID()
        registered(this)
        require(!cancelled)
        val body = JSONObject().put("enclosure_url", enclosure).toString().toRequestBody("application/json".toMediaType())
        val token = try { connection.execute("/api/podcasts/enclosure/peek", "POST", body, emptyMap(), epoch, requestId, 15000).use { response ->
            if (!response.isSuccessful) throw HttpDataSource.InvalidResponseCodeException(response.code, response.message, null, response.headers.toMultimap(), spec, byteArrayOf())
            val raw = response.peekBody(32769).string(); require(raw.toByteArray().size <= 32768)
            JSONObject(raw).getString("stream_token").also { require(it.length in 1..16384 && Regex("^[A-Za-z0-9_-]+$").matches(it)) }
        } } catch (failure: java.io.IOException) {
            if (failure is HttpDataSource.HttpDataSourceException) throw failure
            throw HttpDataSource.HttpDataSourceException.createForIOException(failure, spec, HttpDataSource.HttpDataSourceException.TYPE_OPEN)
        }
        require(!cancelled && epoch == connection.generation)
        val uri = Uri.parse(connection.origin + "/api/podcasts/stream/" + token).buildUpon()
            .appendQueryParameter("android_generation", epoch.toString()).appendQueryParameter("android_occurrence", occurrence).build()
        val source = remote.createDataSource(); listeners.forEach(source::addTransferListener); delegate = source
        return source.open(spec.buildUpon().setUri(uri).build())
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int { require(!cancelled && epoch == connection.generation); return delegate!!.read(buffer, offset, length) }
    override fun getUri(): Uri? = delegate?.uri
    override fun getResponseHeaders(): Map<String, List<String>> = delegate?.responseHeaders ?: emptyMap()
    override fun close() { connection.cancel(requestId); try { delegate?.close() } finally { delegate = null; released() } }
}
