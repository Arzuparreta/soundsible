package com.soundsible.android

import android.os.Handler
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Room-only Socket.IO transport. Never forwards Core cookies, headers or redirects. */
internal class NativeCommunitySocket(
    origin: String, auth: Map<String, String>, private val main: Handler,
    private val owns: () -> Boolean, private val receive: (String, JSONObject) -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean()
    private val endpoint = origin.toHttpUrl().also { require(it.isHttps && it.username.isEmpty() && it.password.isEmpty()) }
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).readTimeout(40, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS).addInterceptor { chain ->
        val url = chain.request().url
        if (url.scheme != endpoint.scheme || url.host != endpoint.host || url.port != endpoint.port) throw java.io.IOException("LIVE_SOCKET_ORIGIN")
        chain.proceed(chain.request())
    }.build()
    private val socket = IO.socket(endpoint.toString(), IO.Options().apply {
        forceNew = true; reconnection = true; reconnectionAttempts = 4
        reconnectionDelay = 500; reconnectionDelayMax = 4000; timeout = 8000
        callFactory = client; webSocketFactory = client; this.auth = auth
    })
    init {
        for (event in listOf(Socket.EVENT_CONNECT, Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR,
            "session_snapshot", "session_updated", "program_event", "chat_message", "presence", "session_ended")) {
            socket.on(event) { arguments ->
                val payload = arguments.firstOrNull() as? JSONObject ?: JSONObject()
                if (payload.toString().length <= 65536) main.post { if (!closed.get() && owns()) receive(event, payload) }
            }
        }
    }
    fun connect() { check(!closed.get()); socket.connect() }
    fun connected() = !closed.get() && socket.connected()
    fun emit(event: String, payload: JSONObject) { if (connected()) socket.emit(event, payload) }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        socket.off(); socket.disconnect()
        client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
    }
}
