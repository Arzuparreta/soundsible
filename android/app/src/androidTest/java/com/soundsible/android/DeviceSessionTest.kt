package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.media3.common.Player
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

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
        val pcm = AtomicBoolean()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            fun device(): JSONObject? = main { active.sessionExtras.getString("nativeDevice") }?.let(::JSONObject)
            await("Native device did not register with Core") { device()?.optBoolean("connected") == true }
            val id = device()!!.getString("device_id")
            await("Core did not acknowledge the registered native device") {
                val devices = request("/api/devices").getJSONArray("devices")
                (0 until devices.length()).any { devices.getJSONObject(it).getString("device_id") == id && devices.getJSONObject(it).getString("device_type") == "android" }
            }
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
            fun remote(command: String, extra: JSONObject = JSONObject()) = request("/api/playback/remote-command", "POST", extra.put("device_id", id).put("command", command))
            remote("pause"); await("Remote pause did not reach background service") { main { !active.playWhenReady } }
            assertEquals(key, main { ProgramQueue.key(active, 0) })
            remote("play"); pcm.set(false); await("Remote play did not restore PCM") { NativeProgramOutput.playing && pcm.get() }
            assertEquals("Remote resume replaced occurrence identity", key, main { ProgramQueue.key(active, 0) })
            remote("seek", JSONObject().put("position_sec", 30)); await("Remote seek failed") { main { active.currentPosition in 30000..35000 } }
            remote("next"); await("Remote next lost duplicate occurrence") { main { active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Second occurrence" } }
            remote("previous"); await("Remote previous failed") { main { active.currentMediaItemIndex == 0 } }
            request("/api/playback/remote-command", "POST", JSONObject().put("device_id", id).put("command", "pause"), cookie = otherCookie, expected = 404)
            assertTrue("Other account paused native playback", main { active.playWhenReady })
            // A browser-origin NORMAL session is transferred through the actual Core handoff route.
            val peerId = java.util.UUID.randomUUID().toString()
            request("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Remote fixture").put("device_type", "web"))
            val remoteQueue = JSONArray().put(JSONObject().put("id", "member-track").put("title", "Remote first").put("artist", "member artist")
                .put("queueId", "remote-first").put("queueLane", "manual").put("queueSource", "library"))
                .put(JSONObject().put("id", "member-track").put("title", "Remote second").put("artist", "member artist")
                    .put("queueId", "remote-second").put("queueLane", "manual").put("queueSource", "library"))
            val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", remoteQueue).put("index", 1)
                .put("shuffle", true).put("repeat", "one").put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", JSONObject.NULL)
            request("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", "member-track").put("track", remoteQueue.getJSONObject(1))
                .put("position_sec", 123).put("is_playing", false).put("session", session))
            request("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            pcm.set(false)
            await("Handoff did not restore queue/position/preferences and PCM") { main { active.mediaItemCount == 2 && active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Remote second" &&
                active.currentPosition in 123000..128000 && active.shuffleModeEnabled && active.repeatMode == Player.REPEAT_MODE_ONE && active.isPlaying } && pcm.get() }
            await("Handoff queue was not republished") { request("/api/playback/state").optJSONObject("session")?.optString("repeat") == "one" }
            main { connection.clearSession(false) }
            await("Logout left native device socket authorized") { device()?.optBoolean("connected") != true }
            assertEquals(404, connection.client.newCall(okhttp3.Request.Builder().url(origin + "/api/playback/remote-command").header("Cookie", otherCookie)
                .post(JSONObject().put("device_id", id).put("command", "play").toString().toRequestBody("application/json".toMediaType())).build()).execute().use { it.code })
            assertFalse(NativeProgramOutput.playing)
        } finally { capture?.close(); main { browser?.release() }; scenario?.close(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
