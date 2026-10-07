package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/** Exhaust real Socket.IO reconnect attempts, then recover service ownership with Activity closed. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceReconnectTest {
    @Test fun httpDeviceReconnect() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsDeviceReconnect() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context); connection.clearSession(true); val epoch = connection.configure(origin)
        val rawClient = connection.client
        fun core(path: String, method: String = "GET", body: JSONObject? = null, fixture: Boolean = false): JSONObject {
            val content = body?.toString()?.toRequestBody("application/json".toMediaType())
            val response = if (fixture) rawClient.newCall(okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated").method(method, content).build()).execute()
                else connection.execute(path, method, content, emptyMap(), epoch, "device-reconnect-${java.util.UUID.randomUUID()}", 15000)
            return response.use { val text = it.body?.string().orEmpty(); assertEquals("$path: $text", 200, it.code); if (text.isBlank()) JSONObject() else JSONObject(text) }
        }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        core("/__fixture/loudness-facts", "POST", JSONObject().put("album", true).put("firstDuration", 20).put("firstFrequency", 440).put("secondFrequency", 880).put("secondRate", 48000).put("secondChannels", 2), true)
        core("/__fixture/socket-timing", "POST", JSONObject().put("enabled", true), true)
        fun <T> main(work: () -> T): T { val value = AtomicReference<T>(); instrumentation.runOnMainSync { value.set(work()) }; return value.get() }
        fun await(label: String, seconds: Long = 30, condition: () -> Boolean) { val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(100) }; fail(label) }
        var scenario: ActivityScenario<MainActivity>? = null; var browser: MediaBrowser? = null; var capture: ProgramPcmTap.Capture? = null
        val pcm = AtomicBoolean()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            fun device() = main { active.sessionExtras.getString("nativeDevice") }?.let(::JSONObject)
            await("Native device not connected") { device()?.optBoolean("connected") == true }
            val id = device()!!.getString("device_id")
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            val selected = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "queue"); putLong("generation", epoch); putInt("index", 0)
                putString("tracks", JSONArray().put(JSONObject().put("source", "local").put("id", "member-track").put("title", "Reconnect music")).toString())
            }) }.get(15, TimeUnit.SECONDS)
            assertEquals(0, selected.resultCode)
            await("Initial PCM missing") { pcm.get() && main { active.isPlaying } }
            main { active.repeatMode = androidx.media3.common.Player.REPEAT_MODE_ALL }
            val key = main { ProgramQueue.key(active, 0) }
            scenario.close(); scenario = null
            core("/__fixture/socket-network", "POST", JSONObject().put("enabled", true), true)
            await("Socket manager did not exhaust bounded attempts into cooldown", 65) { device()?.let { !it.optBoolean("connected") && it.optBoolean("retrying") } == true }
            assertTrue("Socket outage interrupted native playback", main { active.playWhenReady })
            assertEquals(key, main { ProgramQueue.key(active, 0) })
            // Real transport recovers; no WebView, logout or manual reset wakes the device.
            core("/__fixture/socket-network", "POST", JSONObject().put("enabled", false), true)
            await("Exhausted native device never reconnected", 45) { device()?.optBoolean("connected") == true }
            assertEquals("Device identity changed across outage", id, device()!!.getString("device_id"))
            await("Recovered state was not republished") { core("/api/playback/state").optString("device_id") == id }
            core("/api/playback/remote-command", "POST", JSONObject().put("device_id", id).put("command", "pause"))
            await("Recovered remote pause missing") { main { !active.playWhenReady } }
            core("/api/playback/remote-command", "POST", JSONObject().put("device_id", id).put("command", "play"))
            pcm.set(false); await("Recovered remote resume missing PCM") { pcm.get() && main { active.isPlaying } }
            assertEquals(key, main { ProgramQueue.key(active, 0) })
        } finally {
            runCatching { core("/__fixture/socket-network", "POST", JSONObject().put("enabled", false), true); core("/__fixture/socket-timing", "POST", JSONObject().put("enabled", false), true) }
            capture?.close(); main { browser?.release() }; scenario?.close(); connection.clearSession(true); rawClient.dispatcher.cancelAll(); rawClient.connectionPool.evictAll()
        }
    }
}
