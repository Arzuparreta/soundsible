package com.soundsible.android

import android.os.Handler
import android.os.Looper
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A quiet, polling-only room must survive the real 20-second server ping interval. */
class LivePollingTest {
    @Test fun pollingSurvivesQuietRoom() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val epoch = connection.configure(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
        fun request(path: String, method: String, json: String? = null): JSONObject =
            connection.execute(path, method, json?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-polling", 15000).use {
                val text = it.body?.string().orEmpty()
                check(it.isSuccessful) { "Core $path: ${it.code} $text" }; text.takeIf(String::isNotBlank)?.let(::JSONObject) ?: JSONObject()
            }
        request("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}")
        val room = request("/api/community/sessions", "POST", "{\"title\":\"Quiet polling acceptance\"}").getJSONObject("session")
        val errors = AtomicInteger()
        val socket = NativeCommunitySocket(room.getString("socket_url"), mapOf("session_id" to room.getString("id"), "host_token" to room.getString("host_token")),
            Handler(Looper.getMainLooper()), { connection.generation == epoch }, { event, _ ->
                if (event == io.socket.client.Socket.EVENT_DISCONNECT || event == io.socket.client.Socket.EVENT_CONNECT_ERROR) errors.incrementAndGet()
            }, transports = arrayOf("polling"))
        try {
            socket.connect(); socket.awaitConnected()
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(35)
            while (System.nanoTime() < until) { assertEquals("Polling disconnected during the server ping interval", 0, errors.get()); assertTrue(socket.connected()); Thread.sleep(250) }
        } finally { socket.close(); request("/api/community/sessions/${room.getString("id")}", "DELETE"); connection.clearSession(true) }
    }
}
