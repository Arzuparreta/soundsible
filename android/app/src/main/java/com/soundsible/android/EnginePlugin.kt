package com.soundsible.android

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MultipartBody
import android.util.Base64
import java.util.concurrent.Executors

@CapacitorPlugin(name = "SoundsibleEngine")
class EnginePlugin : Plugin() {
    lateinit var connection: EngineConnection
        private set
    private val namespace = java.util.UUID.randomUUID().toString()
    private val ownedRequests = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val executor = Executors.newFixedThreadPool(4)
    private var socket: Socket? = null

    override fun load() {
        connection = EngineConnection.shared(context)
        connection.onReset = { stopSocket() }
    }
    private fun result() = JSObject().put("origin", connection.origin).put("generation", connection.generation)
    @PluginMethod fun state(call: PluginCall) { call.resolve(result()) }
    @PluginMethod fun configure(call: PluginCall) {
        executor.execute {
            try { connection.configure(call.getString("origin") ?: ""); call.resolve(result()) }
            catch (_: Exception) { call.reject("Use an HTTPS origin or HTTP on a private network, without path or credentials.", "INVALID_SERVER") }
        }
    }
    @PluginMethod fun clear(call: PluginCall) {
        connection.clearSession(call.getBoolean("forget", false) == true)
        call.resolve(result())
    }
    @PluginMethod fun cancel(call: PluginCall) { connection.cancel(namespace + ":" + (call.getString("id") ?: "")); call.resolve() }
    @PluginMethod fun request(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        val id = namespace + ":" + (call.getString("id") ?: "")
        ownedRequests.add(id)
        executor.execute {
            try {
                val method = call.getString("method") ?: "GET"
                val headersObj = call.getObject("headers") ?: JSObject()
                val headers = headersObj.keys().asSequence().associateWith { headersObj.getString(it) ?: "" }
                val parts = call.getArray("parts")
                val body = if (parts != null) {
                    val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
                    for (i in 0 until parts.length()) {
                        val part = parts.getJSONObject(i)
                        if (part.has("base64")) builder.addFormDataPart(part.getString("name"), part.getString("filename"),
                            Base64.decode(part.getString("base64"), Base64.DEFAULT).toRequestBody(part.getString("type").toMediaType()))
                        else builder.addFormDataPart(part.getString("name"), part.getString("value"))
                    }
                    builder.build()
                } else call.getString("body")?.toRequestBody("application/json; charset=utf-8".toMediaType())
                    ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null
                connection.execute(call.getString("path") ?: "", method, body, headers,
                    epoch, id, call.getInt("timeoutMs")?.toLong() ?: call.getLong("timeoutMs") ?: 8000L).use { response ->
                    val visibleHeaders = JSObject()
                    listOf("ETag", "Content-Type", "Content-Range").forEach { key -> response.header(key)?.let { visibleHeaders.put(key, it) } }
                    call.resolve(JSObject().put("status", response.code).put("headers", visibleHeaders).put("body", response.body?.string() ?: ""))
                }
            } catch (_: Exception) { call.reject("The server could not be reached or the session changed.", "NETWORK_OR_STALE") }
            finally { ownedRequests.remove(id) }
        }
    }
    @PluginMethod fun events(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        try {
            stopSocket()
            val selectedOrigin = connection.origin
            val cookie = connection.cookieHeader(epoch)
            val options = IO.Options().apply {
                forceNew = true; reconnection = true; reconnectionAttempts = 5
                reconnectionDelay = 1000; reconnectionDelayMax = 5000; timeout = 8000
                callFactory = connection.client; webSocketFactory = connection.client
                extraHeaders = cookie?.let { mapOf("Cookie" to listOf(it)) } ?: emptyMap()
            }
            val next = IO.socket(selectedOrigin, options)
            socket = next
            listOf(Socket.EVENT_CONNECT, Socket.EVENT_DISCONNECT, Socket.EVENT_CONNECT_ERROR,
                "library_updated", "saved_entities_updated", "favourites_updated").forEach { event ->
                next.on(event) {
                    if (epoch == connection.generation && socket === next) {
                        notifyListeners("engineEvent", JSObject().put("event", event).put("generation", epoch))
                    }
                }
            }
            next.connect()
            call.resolve()
        } catch (_: Exception) { call.reject("Could not start account events.", "EVENTS_UNAVAILABLE") }
    }
    @PluginMethod fun stopEvents(call: PluginCall) { stopSocket(); call.resolve() }
    @Synchronized private fun stopSocket() { socket?.off(); socket?.disconnect(); socket = null }
    override fun handleOnDestroy() {
        stopSocket(); connection.onReset = {}
        ownedRequests.forEach { connection.cancel(it) }; ownedRequests.clear(); executor.shutdownNow()
    }
}
