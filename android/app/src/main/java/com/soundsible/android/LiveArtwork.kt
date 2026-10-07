package com.soundsible.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/** Public room thumbnails use a separate origin-bound client without Core credentials. */
internal class LiveArtwork(origin: String, private val roomId: String) : AutoCloseable {
    private val origin = origin.toHttpUrl().also { require(it.isHttps && it.username.isEmpty() && it.password.isEmpty()) }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(8, TimeUnit.SECONDS).addInterceptor { chain ->
            requireOrigin(chain.request().url)
            chain.proceed(chain.request())
        }.build()
    private fun requireOrigin(url: HttpUrl) {
        require(url.isHttps && url.host == origin.host && url.port == origin.port && url.username.isEmpty() && url.password.isEmpty())
    }
    fun upload(bitmap: Bitmap, hostToken: String, trackId: String): String {
        val bytes = ByteArrayOutputStream().apply { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 75, this)) }.toByteArray()
        require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES)
        val url = origin.newBuilder().encodedPath("/v1/sessions/").addPathSegment(roomId).addPathSegment("artwork").query(null).build()
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("track_id", trackId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(48))
            .addFormDataPart("artwork", "thumbnail.jpg", bytes.toRequestBody("image/jpeg".toMediaType())).build()
        return client.newCall(Request.Builder().url(url).header("Authorization", "Bearer $hostToken").post(body).build()).execute().use {
            check(it.code == 201)
            val response = it.body ?: error("LIVE_ARTWORK_EMPTY")
            require(response.contentLength() <= 65536)
            val text = response.byteStream().use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= 65536); output.write(buffer, 0, count) }
                output.toByteArray()
            }
            require(text.size <= 65536)
            JSONObject(String(text, Charsets.UTF_8)).getString("artwork_url").also(::validatedUrl)
        }
    }
    private fun validatedUrl(value: String): HttpUrl = value.toHttpUrl().also {
        requireOrigin(it)
        require(it.encodedPath.startsWith("/v1/artwork/$roomId/") && it.pathSegments.size == 4 && it.query == null && it.fragment == null)
    }
    fun download(value: String): ByteArray = client.newCall(Request.Builder().url(validatedUrl(value)).build()).execute().use {
        check(it.code == 200)
        require(it.header("Content-Type", "")!!.substringBefore(';') in setOf("image/jpeg", "image/png", "image/webp"))
        val body = it.body ?: error("LIVE_ARTWORK_EMPTY")
        require(body.contentLength() <= MAX_BYTES)
        val bytes = body.byteStream().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= MAX_BYTES); output.write(buffer, 0, count) }
            output.toByteArray()
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth in 1..512 && bounds.outHeight in 1..512)
        bytes
    }
    override fun close() { client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    companion object { const val MAX_BYTES = 256 * 1024 }
}
