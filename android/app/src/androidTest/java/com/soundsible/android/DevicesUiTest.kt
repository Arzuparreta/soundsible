package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import io.socket.client.IO
import io.socket.client.Socket
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Actual WebView controls a second authenticated Core socket; no web playback owner. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DevicesUiTest {
    @Test fun httpDevices() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsDevices() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "device-ui-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        val client = connection.client
        val peerId = java.util.UUID.randomUUID().toString()
        val latestStart = java.util.concurrent.atomic.AtomicReference<JSONObject>()
        var browser: androidx.media3.session.MediaBrowser? = null
        val connected = CountDownLatch(1); val paused = CountDownLatch(1); val resumed = CountDownLatch(1)
        val peer = IO.socket(origin, IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(Socket.EVENT_CONNECT) { peer.emit("playback_register", JSONObject().put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop")); connected.countDown() }
        peer.on("playback_stop_requested") { paused.countDown() }; peer.on("playback_start_requested") { arguments -> latestStart.set(arguments.firstOrNull() as? JSONObject); resumed.countDown() }
        val web = StartupTest()
        try {
            peer.connect(); assertTrue(connected.await(15, TimeUnit.SECONDS))
            core("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop"))
            core("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", "member-track")
                .put("track", JSONObject().put("id", "member-track").put("title", "Peer song")).put("position_sec", 42).put("is_playing", true))
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Devices: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Settings').click()")
                waitFor("!!document.querySelector('[data-android-settings-devices]')")
                web.evaluate(scenario, "document.querySelector('[data-android-settings-devices]').click()")
                waitFor("!!document.querySelector('[data-testid=android-settings-devices]')&&document.querySelector('[data-testid=android-settings-devices]').innerText.includes(' (this)')")
                waitFor("!!document.querySelector('[data-testid=android-settings-devices] button[aria-label=Pause]:not(:disabled)')")
                web.evaluate(scenario, "document.querySelector('[data-testid=android-settings-devices] button[aria-label=Pause]').click()")
                assertTrue("UI pause never reached peer Core socket", paused.await(15, TimeUnit.SECONDS))
                waitFor("!!document.querySelector('[data-testid=android-settings-devices] button[aria-label=Play]:not(:disabled)')")
                web.evaluate(scenario, "document.querySelector('[data-testid=android-settings-devices] button[aria-label=Play]').click()")
                assertTrue("UI resume never reached peer Core socket", resumed.await(15, TimeUnit.SECONDS))
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                fun <T> main(work: () -> T): T { val result = java.util.concurrent.atomic.AtomicReference<T>(); instrumentation.runOnMainSync { result.set(work()) }; return result.get() }
                val context = instrumentation.targetContext
                val active = main { androidx.media3.session.MediaBrowser.Builder(context, androidx.media3.session.SessionToken(context,
                    android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
                browser = active
                val queue = org.json.JSONArray().put(JSONObject().put("source", "local").put("id", "member-track").put("title", "Native first"))
                    .put(JSONObject().put("source", "local").put("id", "member-track").put("title", "Native second"))
                val result = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                    putString("action", "queue"); putLong("generation", epoch); putString("tracks", queue.toString()); putInt("index", 1)
                }) }.get(15, TimeUnit.SECONDS)
                assertEquals(0, result.resultCode)
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                while (System.nanoTime() < until && !main { active.isPlaying }) Thread.sleep(50)
                assertTrue(main { active.isPlaying })
                main { active.seekTo(54321); active.repeatMode = androidx.media3.common.Player.REPEAT_MODE_ALL; active.shuffleModeEnabled = true }
                waitFor("!!document.querySelector('[data-testid=android-settings-devices] button:not(:disabled)')&&Array.from(document.querySelectorAll('[data-testid=android-settings-devices] button')).some(b=>b.textContent==='Transfer playback'&&!b.disabled)")
                latestStart.set(null)
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-settings-devices] button')).find(b=>b.textContent==='Transfer playback').click()")
                val transferred = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                while (System.nanoTime() < transferred && latestStart.get()?.optJSONObject("state")?.optJSONObject("session") == null) Thread.sleep(50)
                val state = latestStart.get()!!.getJSONObject("state")
                val session = state.getJSONObject("session")
                assertEquals(2, session.getJSONArray("queue").length()); assertEquals(1, session.getInt("index"))
                assertEquals("Native second", session.getJSONArray("queue").getJSONObject(1).getString("title"))
                assertEquals("all", session.getString("repeat")); assertTrue(session.getBoolean("shuffle"))
                assertTrue("Outgoing position was stale", state.getDouble("position_sec") in 54.0..65.0)
                val stopped = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (System.nanoTime() < stopped && main { active.playWhenReady }) Thread.sleep(50)
                assertFalse("Handoff did not stop native source", main { active.playWhenReady })
                val devices = core("/api/devices").getJSONArray("devices")
                assertEquals("WebView registered an extra native playback owner", 1, (0 until devices.length()).count { devices.getJSONObject(it).optString("device_type") == "android" })
                val types = (0 until devices.length()).map { devices.getJSONObject(it).getString("device_type") }
                assertTrue(types.contains("android")); assertTrue(types.contains("desktop"))
            }
        } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync { browser?.release() }; peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
