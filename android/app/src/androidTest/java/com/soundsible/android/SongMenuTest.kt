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
/** A library song's menu leads to its album and artist pages and starts it on another of the account's devices. */
class SongMenuTest {
    @Test fun httpSongMenu() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsSongMenu() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "song-menu-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        val client = connection.client
        val peerId = java.util.UUID.randomUUID().toString()
        val started = java.util.concurrent.atomic.AtomicReference<JSONObject>()
        val connected = CountDownLatch(1); val received = CountDownLatch(1)
        val peer = IO.socket(origin, IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(Socket.EVENT_CONNECT) {
            peer.emit("playback_register", JSONObject()
                .put("device_id", peerId).put("device_name", "Song menu laptop").put("device_type", "desktop")
                .put("form_factor", "computer").put("instance_id", java.util.UUID.randomUUID().toString()).put("protocol", 1)
                .put("commands", org.json.JSONArray(listOf("play.tracks"))))
            connected.countDown()
        }
        peer.on("device_command") { arguments ->
            val payload = arguments.firstOrNull() as? JSONObject ?: return@on
            val ack = arguments.lastOrNull() as? io.socket.client.Ack
            if (payload.optString("name") == "play.tracks") {
                started.set(payload.optJSONObject("args"))
                received.countDown()
                ack?.call(JSONObject().put("status", "applied").put("rev", 1))
            } else ack?.call(JSONObject().put("status", "rejected").put("reason", "unsupported"))
        }
        val web = StartupTest()
        try {
            peer.connect(); assertTrue(connected.await(15, TimeUnit.SECONDS))
            core("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Song menu laptop").put("device_type", "desktop"))
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Song menu: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                fun menuButton(label: String) = "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()===${JSONObject.quote(label)})"
                fun openMenu() {
                    web.revealLibraryTrack(scenario, "member-track")
                    waitFor("!!document.querySelector('[data-browse-track-id=member-track] [data-row-menu]')")
                    web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-menu]').click()")
                    waitFor("!!document.querySelector('[role=dialog]')")
                }
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")

                // Entity details are neutral (no nav tab pressed). Back and Library return to the collection; Discover opens cleanly.
                openMenu()
                waitFor("!!${menuButton("Go to artist")}&&!!${menuButton("Go to album")}&&!!${menuButton("Play on device")}")
                web.evaluate(scenario, "${menuButton("Go to album")}.click()")
                waitFor("document.querySelector('[data-testid=android-entity-profile] h1')?.textContent==='member album'")
                waitFor("Array.from(document.querySelectorAll('main > nav button')).every(b=>b.getAttribute('aria-pressed')!=='true')")
                waitFor("document.querySelector('[data-testid=android-entity-profile]').innerText.includes('member private song')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('main > nav button')).find(b=>b.textContent==='Library').click()")
                waitFor("Array.from(document.querySelectorAll('main > nav button')).some(b=>b.textContent==='Library'&&b.getAttribute('aria-pressed')==='true')")
                web.revealLibraryTrack(scenario, "member-track")
                waitFor("!!document.querySelector('[data-browse-track-id=member-track]')")
                openMenu(); web.evaluate(scenario, "${menuButton("Go to artist")}.click()")
                waitFor("document.querySelector('[data-testid=android-entity-profile] h1')?.textContent==='member artist'")
                waitFor("Array.from(document.querySelectorAll('main > nav button')).every(b=>b.getAttribute('aria-pressed')!=='true')")
                waitFor("document.querySelector('[data-testid=android-entity-profile]').innerText.includes('member private song')")
                web.evaluate(scenario, "document.querySelector('[data-testid=android-entity-profile] button[aria-label=Back]').click()")
                waitFor("!document.querySelector('[data-testid=android-entity-profile]')&&!!document.querySelector('[data-testid=android-library]')")
                waitFor("Array.from(document.querySelectorAll('main > nav button')).some(b=>b.textContent==='Library'&&b.getAttribute('aria-pressed')==='true')")
                openMenu(); web.evaluate(scenario, "${menuButton("Go to artist")}.click()")
                waitFor("document.querySelector('[data-testid=android-entity-profile] h1')?.textContent==='member artist'")
                web.evaluate(scenario, "document.querySelector('[data-android-discover]').click()")
                waitFor("!!document.querySelector('[data-testid=android-catalog-search]')&&!document.querySelector('[data-testid=android-entity-profile]')")
                waitFor("document.querySelector('[data-android-discover]')?.getAttribute('aria-pressed')==='true'")

                // Play on device lists the other online device only, and that device is asked to play this song.
                web.evaluate(scenario, "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Library').click()")
                openMenu(); web.evaluate(scenario, "${menuButton("Play on device")}.click()")
                waitFor("!!${menuButton("Song menu laptop")}")
                assertEquals("1", web.evaluate(scenario, "document.querySelectorAll('[role=dialog] button[data-pressable]').length"))
                web.evaluate(scenario, "${menuButton("Song menu laptop")}.click()")
                assertTrue("Peer never asked to play", received.await(15, TimeUnit.SECONDS))
                assertEquals("member-track", started.get().getJSONArray("tracks").getJSONObject(0).getString("id"))
                assertEquals(0, started.get().optInt("index", -1))
                // The sending toast turns into the success message once the device answers applied.
                waitFor("Array.from(document.querySelectorAll('[role=status]')).some(s=>s.innerText.includes('Playing'))")
            }
        } finally { peer.off(); peer.disconnect(); connection.clearSession(true) }
    }
}
