package com.soundsible.android

import androidx.media3.common.Player
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Another real Core session controls the service without Activity; different account cannot target it. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceSessionTest {
    @Test fun httpDeviceSession() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsDeviceSession() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true); val epoch = connection.configure(origin)
        connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "native-device-login", 15000).use { assertEquals(200, it.code) }
        // Separate clients do not save response cookies into EngineConnection.
        val client = connection.client
        fun login(username: String): String = client.newCall(okhttp3.Request.Builder().url(origin + "/api/auth/login")
            .post(JSONObject().put("username", username).put("password", "android-test").toString().toRequestBody("application/json".toMediaType())).build()).execute().use {
                assertEquals(200, it.code); it.headers.values("Set-Cookie").single { value -> value.startsWith("sb_session=") }.substringBefore(';')
            }
        val peerCookie = login("member")
        val otherCookie = login("owner")
        fun request(path: String, method: String = "GET", body: JSONObject? = null, cookie: String = peerCookie, expected: Int = 200): JSONObject =
            client.newCall(okhttp3.Request.Builder().url(origin + path).header("Cookie", cookie)
                .method(method, body?.toString()?.toRequestBody("application/json".toMediaType())).build()).execute().use {
                    val text = it.body?.string().orEmpty(); if (!(path == "/api/playback/state" && it.code == 204)) assertEquals("$path: $text", expected, it.code); if (text.isBlank()) JSONObject() else JSONObject(text)
                }
        fun <T> main(work: () -> T): T { val value = AtomicReference<T>(); instrumentation.runOnMainSync { value.set(work()) }; return value.get() }
        fun await(label: String, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label)
        }
        var scenario: ActivityScenario<MainActivity>? = null
        var browser: MediaBrowser? = null
        var capture: ProgramPcmTap.Capture? = null
        var peer: Socket? = null
        val pcm = AtomicBoolean()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            fun device(): JSONObject? = main { active.sessionExtras.getString("nativeDevice") }?.let(::JSONObject)
            await("Native device did not register with Core") { device()?.optBoolean("connected") == true }
            val id = device()!!.getString("device_id")
            var row: JSONObject? = null
            await("Core did not acknowledge the registered native device") {
                val devices = request("/api/devices").getJSONArray("devices")
                row = (0 until devices.length()).map { devices.getJSONObject(it) }
                    .firstOrNull { it.optString("device_id") == id && it.optString("device_type") == "android" && it.optInt("protocol", -1) == 1 }
                row != null
            }
            assertTrue(row!!.optString("form_factor") in listOf("phone", "tablet"))
            val declared = row!!.getJSONArray("commands").let { arr -> (0 until arr.length()).map { arr.getString(it) } }
            assertTrue("transport.pause" in declared)
            assertTrue("play.tracks" in declared)
            assertTrue("queue.move" in declared)
            assertFalse("transport.set_volume" in declared)
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            val queue = JSONArray().put(JSONObject().put("id", "member-track").put("source", "local").put("title", "First occurrence"))
                .put(JSONObject().put("id", "member-track").put("source", "local").put("title", "Second occurrence"))
            val selected = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "queue"); putLong("generation", epoch); putString("tracks", queue.toString()); putInt("index", 0)
            }) }.get(15, TimeUnit.SECONDS)
            assertEquals(0, selected.resultCode)
            await("Native queue did not play PCM") { pcm.get() && NativeProgramOutput.playing }
            await("Native queue snapshot not published") {
                val state = request("/api/playback/state")
                state.optString("device_id") == id && state.optJSONObject("session")?.optJSONArray("queue")?.length() == 2
            }
            val key = main { ProgramQueue.key(active, 0) }
            scenario.close(); scenario = null
            fun remote(name: String, args: JSONObject = JSONObject(), expected: Int = 200): JSONObject =
                request("/api/devices/$id/commands", "POST", JSONObject().put("name", name).put("args", args), expected = expected)
            val paused = remote("transport.pause")
            assertEquals("applied", paused.optString("status")); assertTrue(paused.optLong("rev", -1) >= 0)
            await("Remote pause did not reach background service") { main { !active.playWhenReady } }
            assertEquals(key, main { ProgramQueue.key(active, 0) })
            pcm.set(false)
            assertEquals("applied", remote("transport.play").optString("status"))
            await("Remote play did not restore PCM") { NativeProgramOutput.playing && pcm.get() }
            assertEquals("Remote resume replaced occurrence identity", key, main { ProgramQueue.key(active, 0) })
            assertEquals("applied", remote("transport.seek", JSONObject().put("position_sec", 8)).optString("status"))
            await("Remote seek failed") { main { active.currentPosition in 8000..13000 } }
            assertEquals("applied", remote("transport.next").optString("status"))
            await("Remote next lost duplicate occurrence") { main { active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Second occurrence" } }
            assertEquals("applied", remote("transport.previous").optString("status"))
            await("Remote previous failed") { main { active.currentMediaItemIndex == 0 } }
            val missing = remote("queue.remove", JSONObject().put("queue_id", "missing-occurrence"), expected = 409)
            assertEquals("rejected", missing.optString("status"))
            assertEquals("not_found", missing.optString("reason"))
            request("/api/devices/$id/commands", "POST", JSONObject().put("name", "transport.pause").put("args", JSONObject()), cookie = otherCookie, expected = 404)
            assertTrue("Other account paused native playback", main { active.playWhenReady })
            // A browser-origin NORMAL session is transferred to Android through POST /api/devices/transfer.
            val peerId = java.util.UUID.randomUUID().toString()
            request("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Remote fixture").put("device_type", "web"))
            val remoteQueue = JSONArray().put(JSONObject().put("id", "member-track").put("title", "Remote first").put("artist", "member artist")
                .put("queueId", "remote-first").put("queueLane", "manual").put("queueSource", "library"))
                .put(JSONObject().put("id", "member-track").put("title", "Remote second").put("artist", "member artist")
                    .put("queueId", "remote-second").put("queueLane", "manual").put("queueSource", "library"))
            val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", remoteQueue).put("index", 1)
                .put("shuffle", true).put("repeat", "one").put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", JSONObject.NULL)
            request("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", "member-track").put("track", remoteQueue.getJSONObject(1))
                .put("position_sec", 5).put("is_playing", false).put("session", session))
            pcm.set(false)
            val incoming = request("/api/devices/transfer", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            assertEquals("applied", incoming.optString("status"))
            await("Transfer did not restore queue/position/preferences and PCM") { main { active.mediaItemCount == 2 && active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Remote second" &&
                active.currentPosition in 5000..10000 && active.shuffleModeEnabled && active.repeatMode == Player.REPEAT_MODE_ONE && active.isPlaying } && pcm.get() }
            await("Transferred queue was not republished") { request("/api/playback/state").optJSONObject("session")?.optString("repeat") == "one" }
            // Transfer back from Android to an online peer and confirm Android pauses after peer confirms playback.
            val peerConnected = CountDownLatch(1)
            val peerImported = AtomicReference<JSONObject>()
            val peerSocket = IO.socket(origin, IO.Options().apply {
                forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
                extraHeaders = mapOf("Cookie" to listOf(peerCookie))
            })
            peer = peerSocket
            peerSocket.on(Socket.EVENT_CONNECT) {
                peerSocket.emit("playback_register", JSONObject()
                    .put("device_id", peerId).put("device_name", "Remote fixture").put("device_type", "web")
                    .put("form_factor", "computer").put("instance_id", java.util.UUID.randomUUID().toString()).put("protocol", 1)
                    .put("commands", JSONArray(listOf("session.export", "session.import", "session.release"))))
                peerConnected.countDown()
            }
            peerSocket.on("device_command") { arguments ->
                val payload = arguments.firstOrNull() as? JSONObject ?: return@on
                val ack = arguments.lastOrNull() as? Ack
                when (payload.optString("name")) {
                    "session.import" -> {
                        peerImported.set(payload.optJSONObject("args")?.optJSONObject("state"))
                        ack?.call(JSONObject().put("status", "applied").put("rev", 1))
                    }
                    "session.release" -> ack?.call(JSONObject().put("status", "applied").put("rev", 2))
                    else -> ack?.call(JSONObject().put("status", "rejected").put("reason", "unsupported"))
                }
            }
            peerSocket.connect(); assertTrue(peerConnected.await(15, TimeUnit.SECONDS))
            await("Peer socket not online") {
                val devices = request("/api/devices").getJSONArray("devices")
                (0 until devices.length()).any { devices.getJSONObject(it).let { r -> r.optString("device_id") == peerId && r.optBoolean("online") } }
            }
            val outgoing = request("/api/devices/transfer", "POST", JSONObject().put("from_device_id", id).put("to_device_id", peerId))
            assertEquals("applied", outgoing.optString("status"))
            val exported = peerImported.get()
            assertNotNull("Peer never received session.import", exported)
            assertEquals("one", exported!!.getJSONObject("session").getString("repeat"))
            assertTrue(exported.getJSONObject("session").getBoolean("shuffle"))
            await("Outgoing transfer did not release native playback") { main { !active.playWhenReady } }
            main { connection.clearSession(false) }
            await("Logout left native device socket authorized") { device()?.optBoolean("connected") != true }
            assertEquals(404, connection.client.newCall(okhttp3.Request.Builder().url(origin + "/api/devices/$id/commands").header("Cookie", otherCookie)
                .post(JSONObject().put("name", "transport.play").put("args", JSONObject()).toString().toRequestBody("application/json".toMediaType())).build()).execute().use { it.code })
            assertFalse(NativeProgramOutput.playing)
        } finally { capture?.close(); main { browser?.release() }; scenario?.close(); peer?.off(); peer?.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
