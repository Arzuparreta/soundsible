package com.soundsible.android

import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import java.io.ByteArrayInputStream
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Dns
import java.net.InetAddress
import java.util.concurrent.TimeUnit

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(EnginePlugin::class.java)
        registerPlugin(PlaybackPlugin::class.java)
        registerPlugin(OfflinePlugin::class.java)
        super.onCreate(savedInstanceState)
        bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                // Authenticated artwork is served at a generation-bound local URL;
                // it is never installed in the WebView cookie jar or disk cache.
                if (uri.host == "localhost" && uri.path?.startsWith("/__engine/") == true) {
                    return try {
                        val parts = uri.pathSegments
                        require(parts.size >= 6 && parts[2] == "api" && parts[3] == "static" && parts[4] == "cover")
                        val plugin = bridge.getPlugin("SoundsibleEngine").instance as EnginePlugin
                        val epoch = parts[1].toLong()
                        val path = uri.encodedPath!!.substringAfter("/__engine/$epoch") + (uri.encodedQuery?.let { "?$it" } ?: "")
                        plugin.connection.execute(path, "GET", null, emptyMap(), epoch, "cover-${System.nanoTime()}", 8000).use {
                            require(it.body != null && it.body!!.contentLength() <= ProgramArtwork.MAX_BYTES)
                            val output = java.io.ByteArrayOutputStream()
                            val chunk = ByteArray(8192)
                            it.body!!.byteStream().use { input ->
                                while (true) {
                                    val count = input.read(chunk)
                                    if (count < 0) break
                                    require(output.size() + count <= ProgramArtwork.MAX_BYTES && epoch == plugin.connection.generation)
                                    output.write(chunk, 0, count)
                                }
                            }
                            val bytes = output.toByteArray()
                            require(epoch == plugin.connection.generation)
                            require(it.code == 200 && it.header("Content-Type", "")!!.startsWith("image/"))
                            WebResourceResponse(it.header("Content-Type")!!.substringBefore(';'), null, 200, "OK",
                                mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))
                        }
                    } catch (_: Exception) { WebResourceResponse("text/plain", "utf-8", 403, "Unavailable",
                        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0))) }
                }
                // All network I/O belongs to the native transport. Remote pages,
                // embeds and images cannot inherit credentials or access the bridge.
                if (uri.host != "localhost") return try {
                    require(request.method == "GET" && uri.userInfo == null && uri.scheme in setOf("http", "https"))
                    val publicClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                        .dns(object : Dns { override fun lookup(hostname: String): List<InetAddress> {
                            val addresses = Dns.SYSTEM.lookup(hostname)
                            if (uri.scheme == "http") require(addresses.all { EngineConnection.privateAddress(it) })
                            return addresses
                        } }).callTimeout(8, TimeUnit.SECONDS).build()
                    publicClient.newCall(Request.Builder().url(uri.toString()).build()).execute().use {
                        require(it.code == 200 && it.header("Content-Type", "")!!.startsWith("image/"))
                        val input = it.body!!.byteStream()
                        val output = java.io.ByteArrayOutputStream()
                        val chunk = ByteArray(8192)
                        while (true) {
                            val count = input.read(chunk)
                            if (count < 0) break
                            require(output.size() + count <= 8 * 1024 * 1024)
                            output.write(chunk, 0, count)
                        }
                        val bytes = output.toByteArray() // No session/header/cache on external artwork.
                        WebResourceResponse(it.header("Content-Type")!!.substringBefore(';'), null, 200, "OK",
                            mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))
                    }
                } catch (_: Exception) { WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0))) }
                return super.shouldInterceptRequest(view, request)
            }
        })
    }
}
