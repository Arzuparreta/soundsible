package com.soundsible.android

import com.getcapacitor.*
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import androidx.activity.result.ActivityResult
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
    @Volatile private var closed = false
    private var socket: Socket? = null

    override fun load() {
        connection = EngineConnection.shared(context)
        connection.onReset = { stopSocket() }
    }
    /** Runs `work` off the bridge thread. The WebView can still deliver a call
     * after `handleOnDestroy` shut the pool down; executing it then threw
     * RejectedExecutionException on the bridge thread and crashed the app. */
    private fun dispatch(call: PluginCall, work: () -> Unit): Boolean {
        if (!closed) try { executor.execute { work() }; return true } catch (_: java.util.concurrent.RejectedExecutionException) {}
        call.reject("The engine bridge is closed.", "ENGINE_CLOSED")
        return false
    }
    private fun result() = JSObject().put("origin", connection.origin).put("generation", connection.generation)
    @PluginMethod fun state(call: PluginCall) { call.resolve(result()) }
    @PluginMethod fun deviceName(call: PluginCall) { call.resolve(JSObject().put("name", DeviceName.get(context))) }
    /** Opens the camera for a pairing code; the scanned text goes back to the WebView, which validates it before any request. */
    @PluginMethod fun scanPairing(call: PluginCall) {
        val intent = android.content.Intent(context, PairingScanActivity::class.java)
            .putExtra(PairingScanActivity.EXTRA_HINT, call.getString("hint")).putExtra(PairingScanActivity.EXTRA_CLOSE, call.getString("close"))
        try { startActivityForResult(call, intent, "pairingScanned") }
        catch (_: Exception) { call.reject("Camera unavailable", "PAIRING_CAMERA_UNAVAILABLE") }
    }
    @ActivityCallback private fun pairingScanned(call: PluginCall?, result: ActivityResult) {
        val active = call ?: return
        val text = result.data?.getStringExtra(PairingScanActivity.EXTRA_TEXT)
        if (result.resultCode == android.app.Activity.RESULT_OK && text != null && PairingQr.isPairing(text)) { active.resolve(JSObject().put("text", text)); return }
        when (result.data?.getStringExtra(PairingScanActivity.EXTRA_ERROR)) {
            "camera_denied" -> active.reject("Camera permission denied", "PAIRING_CAMERA_DENIED")
            "camera_unavailable" -> active.reject("Camera unavailable", "PAIRING_CAMERA_UNAVAILABLE")
            else -> active.reject("Scan cancelled", "PAIRING_SCAN_CANCELLED")
        }
    }
    @PluginMethod fun configure(call: PluginCall) {
        dispatch(call) {
            try { connection.configure(call.getString("origin") ?: ""); call.resolve(result()) }
            catch (_: Exception) { call.reject("Use an HTTPS origin or HTTP on a private network, without path or credentials.", "INVALID_SERVER") }
        }
    }
    @PluginMethod fun clear(call: PluginCall) {
        connection.clearSession(call.getBoolean("forget", false) == true)
        call.resolve(result())
    }
    @PluginMethod fun cancel(call: PluginCall) { val id = namespace + ":" + (call.getString("id") ?: ""); ImportFiles.cancel(id); connection.cancel(id); call.resolve() }
    @PluginMethod fun request(call: PluginCall) {
        val epoch = call.getInt("generation")?.toLong() ?: call.getLong("generation") ?: -1L
        val id = namespace + ":" + (call.getString("id") ?: "")
        ownedRequests.add(id)
        val queued = dispatch(call) {
            try {
                val method = call.getString("method") ?: "GET"
                val headersObj = call.getObject("headers") ?: JSObject()
                val headers = headersObj.keys().asSequence().associateWith { headersObj.getString(it) ?: "" }
                val requestPath = call.getString("path") ?: ""
                val parts = call.getArray("parts")
                val body = if (parts != null) {
                    val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
                    for (i in 0 until parts.length()) {
                        val part = parts.getJSONObject(i)
                        if (part.has("importToken")) {
                            require(method == "POST" && requestPath == "/api/migration/jobs" && parts.length() == 1 && part.getString("name") == "file")
                            val selected = ImportFiles.claim(connection, epoch, id, part.getString("importToken"))
                            builder.addFormDataPart("file", selected.name, selected.body)
                        } else if (part.has("base64")) builder.addFormDataPart(part.getString("name"), part.getString("filename"),
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
                    val text = response.body?.string() ?: ""
                    val path = call.getString("path")
                    if (epoch == connection.generation) {
                        if (response.code == 401) connection.offline.clear()
                        if (response.isSuccessful && path in listOf("/api/auth/state", "/api/auth/login")) {
                            org.json.JSONObject(text).optJSONObject("user")?.let { connection.offline.bind(it) }
                        }
                    }
                    call.resolve(JSObject().put("status", response.code).put("headers", visibleHeaders).put("body", text))
                }
            } catch (_: Exception) { call.reject("The server could not be reached or the session changed.", "NETWORK_OR_STALE") }
            finally { ImportFiles.finish(id); ownedRequests.remove(id) }
        }
        if (!queued) ownedRequests.remove(id)
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
                "library_updated", "saved_entities_updated", "favourites_updated", "downloader_update").forEach { event ->
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
        closed = true
        stopSocket(); connection.onReset = {}
        ownedRequests.forEach { ImportFiles.cancel(it); connection.cancel(it); ImportFiles.finish(it) }; ownedRequests.clear(); executor.shutdownNow()
    }
}
