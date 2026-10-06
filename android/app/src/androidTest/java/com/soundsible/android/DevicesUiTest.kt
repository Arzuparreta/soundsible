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
        val connected = CountDownLatch(1); val paused = CountDownLatch(1); val resumed = CountDownLatch(1)
        val peer = IO.socket(origin, IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(Socket.EVENT_CONNECT) { peer.emit("playback_register", JSONObject().put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop")); connected.countDown() }
        peer.on("playback_stop_requested") { paused.countDown() }; peer.on("playback_start_requested") { resumed.countDown() }
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
                val devices = core("/api/devices").getJSONArray("devices")
                assertEquals("WebView registered an extra native playback owner", 1, (0 until devices.length()).count { devices.getJSONObject(it).optString("device_type") == "android" })
                val types = (0 until devices.length()).map { devices.getJSONObject(it).getString("device_type") }
                assertTrue(types.contains("android")); assertTrue(types.contains("desktop"))
            }
        } finally { peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
