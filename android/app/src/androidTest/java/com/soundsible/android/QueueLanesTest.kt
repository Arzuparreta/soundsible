package com.soundsible.android
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
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
/**
 * The web's queue model in the native service: requests play after the current song and before the rest of
 * what is playing, "Clear requests" removes only them, and a session left on another device is offered on
 * launch and handed to this phone. HTTP only (no transport change).
 */
class QueueLanesTest {
    @Test fun httpQueueLanesAndResume() {
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "queue-lanes-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }; if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        val client = connection.client
        val peerId = java.util.UUID.randomUUID().toString()
        val connected = CountDownLatch(1); val stopped = CountDownLatch(1)
        val peer = IO.socket(origin, IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(Socket.EVENT_CONNECT) { peer.emit("playback_register", JSONObject().put("device_id", peerId).put("device_name", "Resume laptop").put("device_type", "desktop")); connected.countDown() }
        peer.on("playback_stop_requested") { stopped.countDown() }
        val web = StartupTest()
        try {
            peer.connect(); assertTrue(connected.await(15, TimeUnit.SECONDS))
            core("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Resume laptop").put("device_type", "desktop"))
            core("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("device_name", "Resume laptop").put("track_id", "member-track")
                .put("track", JSONObject().put("id", "member-track").put("title", "Left on the laptop").put("artist", "member artist")).put("position_sec", 42).put("is_playing", true))
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Queue lanes: $condition; " + web.evaluate(scenario, "document.body.innerText") + " " + web.evaluate(scenario, "JSON.stringify(window.__lanes?.items?.map(i=>[i.title,i.lane]))"))
                }
                fun command(body: String) { web.evaluate(scenario, "window.__done=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__lanes,$body}).then(()=>window.__done=true,e=>window.__done='failed:'+e.message)"); waitFor("window.__done===true") }
                fun titles() = web.evaluate(scenario, "JSON.stringify(window.__lanes.items.map(i=>i.title+'|'+(i.lane||'')))")
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en');localStorage.removeItem('resume_suppress_until')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "window.__timer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__lanes=s),100)")

                // Launch offers the laptop's session; accepting moves it here and stops the laptop.
                waitFor("document.querySelector('[data-resume-banner]')?.textContent.includes('Resume laptop')===true")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-resume-banner] button')).find(b=>b.textContent==='Resume').click()")
                assertTrue("The laptop was never asked to stop", stopped.await(15, TimeUnit.SECONDS))
                waitFor("window.__lanes?.items?.[window.__lanes.index]?.id==='member-track'&&window.__lanes.playing&&window.__lanes.positionMs>=40000&&!document.querySelector('[data-resume-banner]')")
                command("action:'pause'")

                // Requests go after the current song and before the rest of what is playing.
                val ctx = JSONArray(); for (t in listOf("Ctx one", "Ctx two", "Ctx three")) ctx.put(JSONObject().put("source", "local").put("id", "member-track").put("title", t).put("artist", "member artist").put("duration", 600))
                command("action:'queue',index:0,tracks:$ctx"); command("action:'pause'")
                fun request(title: String) = JSONArray().put(JSONObject().put("source", "local").put("id", "member-track").put("title", title).put("artist", "member artist").put("duration", 600))
                // Each edit is checked against the queue token the service last published.
                waitFor("window.__lanes.items.length===3"); command("action:'append',tracks:${request("Request one")}")
                waitFor("window.__lanes.items.length===4"); command("action:'append',tracks:${request("Request two")}")
                waitFor("window.__lanes.items.length===5"); command("action:'insertAfter',index:window.__lanes.index,key:window.__lanes.items[window.__lanes.index].key,tracks:${request("Play next")}")
                waitFor("window.__lanes.items.length===6")
                assertEquals(JSONArray(listOf("Ctx one|context", "Play next|manual", "Request one|manual", "Request two|manual", "Ctx two|context", "Ctx three|context")).toString(),
                    JSONArray(titles().trim('"').replace("\\\"", "\"")).toString())
                val current = web.evaluate(scenario, "window.__lanes.items[window.__lanes.index].key")

                // "Clear requests" in the queue removes exactly those, keeping the song, its place and the album.
                waitFor("!!document.querySelector('[data-queue-clear-requests]:not(:disabled)')")
                web.evaluate(scenario, "document.querySelector('[data-queue-clear-requests]').click()")
                waitFor("window.__lanes.items.length===3&&!document.querySelector('[data-queue-clear-requests]')")
                assertEquals(JSONArray(listOf("Ctx one|context", "Ctx two|context", "Ctx three|context")).toString(), JSONArray(titles().trim('"').replace("\\\"", "\"")).toString())
                assertEquals(current, web.evaluate(scenario, "window.__lanes.items[window.__lanes.index].key"))
                assertEquals("false", web.evaluate(scenario, "window.__lanes.playWhenReady"))
            }
        } finally { peer.off(); peer.disconnect(); connection.clearSession(true) }
    }
}
