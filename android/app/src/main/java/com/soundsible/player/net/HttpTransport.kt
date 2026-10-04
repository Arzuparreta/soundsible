package com.soundsible.player.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

sealed class SoundsibleError(message: String) : Exception(message) {
    /** The server answered, and said no. */
    class Http(val status: Int, val serverMessage: String) : SoundsibleError(
        serverMessage.ifEmpty { "The server returned $status." },
    )

    /** The server never answered, or answered something that was not HTTP. */
    class Transport(detail: String) : SoundsibleError("Could not reach your Soundsible: $detail")

    /** The body arrived but did not match the contract. */
    class Decoding(detail: String) : SoundsibleError("Unexpected answer from your Soundsible: $detail")

    /** No server has been paired yet. */
    data object NotConfigured : SoundsibleError("No Soundsible paired yet.")

    /** The credential was rejected or has been revoked. */
    data object Unauthorized : SoundsibleError("This device is no longer paired with your Soundsible.")
}

data class HttpResponse(val status: Int, val body: String)

/** The one seam between the client and the network. */
interface HttpTransport {
    suspend fun send(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse
}

/** Real transport over HttpURLConnection. No third-party HTTP dependency. */
class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : HttpTransport {
    override suspend fun send(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpResponse = withContext(Dispatchers.IO) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            for ((k, v) in headers) setRequestProperty(k, v)
            if (body != null) {
                doOutput = true
                outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body) }
            }
        }
        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = if (stream != null) {
                BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
            } else {
                ""
            }
            HttpResponse(status, text)
        } catch (e: Exception) {
            throw SoundsibleError.Transport(e.message ?: e.javaClass.simpleName)
        } finally {
            conn.disconnect()
        }
    }
}
