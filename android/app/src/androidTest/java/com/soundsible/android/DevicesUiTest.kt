package com.soundsible.android

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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Connected mode: the Android app controls another device (a fixture peer on a second Core
 * socket) through the service's forwarded watch state and the contract's HTTP commands. */
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
        val peerInstance = java.util.UUID.randomUUID().toString()
        val peerSeq = AtomicLong(0)
        // The peer's own playback, which it publishes after every command like a real target.
        val peerIndex = AtomicInteger(0); val peerPlaying = AtomicBoolean(true)
        val queue = JSONArray().put(entry("peer-a", "Peer first")).put(entry("peer-b", "Peer second"))
        fun peerState(): JSONObject = JSONObject().put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop")
            .put("track_id", "member-track").put("track", queue.getJSONObject(peerIndex.get())).put("position_sec", 12).put("is_playing", peerPlaying.get())
            .put("live", JSONObject().put("phase", if (peerPlaying.get()) "playing" else "paused").put("duration", 600).put("dj", JSONObject.NULL))
            .put("session", JSONObject().put("v", 1).put("mode", "now_playing").put("queue", queue).put("index", peerIndex.get())
                .put("shuffle", false).put("repeat", "off").put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", JSONObject.NULL))
        fun publish(): Long = core("/api/playback/state", "PUT", peerState().put("instance_id", peerInstance).put("seq", peerSeq.incrementAndGet())).optLong("rev")
        val received = CopyOnWriteArrayList<JSONObject>()
        val released = CountDownLatch(1)
        val worker = Executors.newSingleThreadExecutor()
        val peer = IO.socket(origin, IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        val registered = AtomicInteger(0)
        peer.on(Socket.EVENT_CONNECT) {
            peer.emit("playback_register", JSONObject()
                .put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop")
                .put("form_factor", "computer").put("instance_id", peerInstance).put("protocol", 1)
                .put("commands", JSONArray(listOf("transport.play", "transport.pause", "transport.next", "transport.previous", "transport.seek",
                    "transport.set_shuffle", "transport.set_repeat", "play.tracks", "queue.add", "queue.move", "queue.remove", "queue.play_entry",
                    "session.export", "session.import", "session.release"))))
            registered.incrementAndGet()
        }
        peer.on("device_command") { arguments ->
            val payload = arguments.firstOrNull() as? JSONObject ?: return@on
            val ack = arguments.lastOrNull() as? Ack
            val name = payload.optString("name"); val args = payload.optJSONObject("args") ?: JSONObject()
            received.add(JSONObject().put("name", name).put("args", args))
            // Publishing is HTTP: keep it off the socket's event thread, as a real device does.
            worker.execute {
                fun applied() = ack?.call(JSONObject().put("status", "applied").put("rev", publish()))
                when (name) {
                    "transport.pause" -> { peerPlaying.set(false); applied() }
                    "transport.play" -> { peerPlaying.set(true); applied() }
                    "queue.play_entry" -> { peerIndex.set(if (args.optString("queue_id") == "peer-b") 1 else 0); applied() }
                    "play.tracks" -> applied()
                    "transport.next" -> ack?.call(JSONObject().put("status", "rejected").put("reason", "locked"))
                    "session.export" -> ack?.call(JSONObject().put("status", "applied").put("state", peerState()))
                    "session.release" -> { peerPlaying.set(false); applied(); released.countDown() }
                    else -> ack?.call(JSONObject().put("status", "rejected").put("reason", "unsupported"))
                }
            }
        }
        val web = StartupTest()
        fun commands(name: String) = received.filter { it.getString("name") == name }
        fun awaitCommand(name: String, label: String, accept: (JSONObject) -> Boolean = { true }) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (commands(name).any { accept(it.getJSONObject("args")) }) return; Thread.sleep(50) }
            fail("$label: $name never reached the peer; received=${received.map { it.getString("name") }}")
        }
        try {
            peer.connect()
            val online = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (registered.get() == 0 && System.nanoTime() < online) Thread.sleep(50)
            assertTrue("Peer never connected", registered.get() > 0)
            core("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Remote test laptop").put("device_type", "desktop"))
            publish()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String, evidence: String = "document.body.innerText") {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Connected mode: $condition; " + web.evaluate(scenario, evidence))
                }
                fun button(scope: String, label: String) = "Array.from(document.querySelectorAll(${JSONObject.quote(scope)})).find(b=>b.textContent.trim()===${JSONObject.quote(label)}&&!b.disabled)"
                val program = "[data-testid=android-program] button"
                val devices = "document.querySelector('[data-android-devices]')?.textContent.trim()"
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en');localStorage.setItem('android:remote:target',${JSONObject.quote(peerId)})"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "window.__deviceStates=[];Capacitor.Plugins.SoundsiblePlayback.addListener('device_state',e=>window.__deviceStates.push({generation:e.generation,id:e.device_id,rev:e.rev,playing:e.is_playing}))")

                // Check local startup after the account socket is ready, when the old rule would attach.
                web.evaluate(scenario, "window.__nativeDevice=null;Capacitor.Plugins.SoundsiblePlayback.addListener('nativeDeviceState',s=>window.__nativeDevice=s).then(()=>Capacitor.Plugins.SoundsiblePlayback.deviceState()).then(s=>{window.__nativeDevice??=s})")
                waitFor("window.__nativeDevice?.connected===true", "JSON.stringify(window.__nativeDevice)")
                assertEquals("Startup changed the output device", JSONObject.quote("Devices"), web.evaluate(scenario, devices))
                web.evaluate(scenario, "document.querySelector('[data-android-devices]').click()")
                val laptopRow = "document.querySelector('[data-connect-sheet] [data-device-row='+CSS.escape(${JSONObject.quote(peerId)})+']')"
                waitFor("!!$laptopRow&&$laptopRow.getAttribute('aria-checked')==='false'")
                web.evaluate(scenario, "$laptopRow.click()")
                waitFor("$devices==='Playing on Remote test laptop'")
                waitFor("document.querySelector('[data-testid=android-program]')?.innerText.includes('Peer first')===true&&!!${button(program, "Pause")}")
                assertTrue("The phone played locally", commands("play.tracks").isEmpty())

                // deviceWatch answers with the engine's acknowledgement for this account only.
                web.evaluate(scenario, "window.__ack=null;Capacitor.Plugins.SoundsiblePlayback.deviceState().then(s=>{window.__generation=s.generation;return Capacitor.Plugins.SoundsiblePlayback.deviceWatch({generation:s.generation,device_id:${JSONObject.quote(peerId)}})})" +
                    ".then(a=>window.__ack={id:a.device&&a.device.device_id,queue:a.state&&a.state.session&&a.state.session.queue.length},e=>window.__ack={failed:String(e&&e.message)})")
                waitFor("window.__ack?.id===${JSONObject.quote(peerId)}&&window.__ack.queue===2", "JSON.stringify({ ack:window.__ack, device:window.__nativeDevice })")
                web.evaluate(scenario, "window.__stale=null;Capacitor.Plugins.SoundsiblePlayback.deviceWatch({generation:window.__generation+1,device_id:${JSONObject.quote(peerId)}}).then(()=>window.__stale='resolved',()=>window.__stale='rejected')")
                waitFor("window.__stale==='rejected'")

                // Transport from the player surface reaches the laptop; its published state comes back through the service.
                web.evaluate(scenario, "${button(program, "Pause")}.click()")
                awaitCommand("transport.pause", "Pause")
                waitFor("!!${button(program, "Play")}")
                waitFor("window.__deviceStates.some(e=>e.id===${JSONObject.quote(peerId)}&&e.generation===window.__generation&&e.playing===false)")

                // A rejected command keeps the state and says why.
                web.evaluate(scenario, "${button(program, "Next")}.click()")
                awaitCommand("transport.next", "Next")
                waitFor("document.body.innerText.includes('That song is already mixing in')")

                // Queue entries are named by queue_id.
                waitFor("!!document.querySelector('[data-testid=program-queue] [data-queue-key=peer-b] [data-row-main]')")
                web.evaluate(scenario, "document.querySelector('[data-testid=program-queue] [data-queue-key=peer-b] [data-row-main]').click()")
                awaitCommand("queue.play_entry", "Queue") { it.optString("queue_id") == "peer-b" }
                waitFor("document.querySelector('[data-testid=android-program]')?.innerText.includes('Peer second')===true")

                // Library plays on the controlled device, not here.
                web.revealLibraryTrack(scenario, "member-track")
                web.evaluate(scenario, "document.querySelector('[data-testid=android-library] [data-browse-track-id=member-track] [data-row-main]').click()")
                awaitCommand("play.tracks", "Library") { it.optJSONArray("tracks")?.optJSONObject(it.optInt("index"))?.optString("id") == "member-track" }
                web.evaluate(scenario, "window.__local=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__local=s.items.length)")
                waitFor("window.__local===0")

                // The laptop disconnects: the player says so and stays on it; it is controlled again once it is back.
                peer.disconnect()
                waitFor("$devices==='Remote test laptop is not reachable'")
                val before = registered.get()
                peer.connect()
                val back = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
                while (registered.get() == before && System.nanoTime() < back) Thread.sleep(50)
                waitFor("$devices==='Playing on Remote test laptop'")

                // "Move session here": the session moves to this phone, the laptop is released, and the player shows this phone.
                web.evaluate(scenario, "document.querySelector('[data-android-devices]').click()")
                waitFor("!!${button("[data-connect-sheet] button", "Move session here")}")
                web.evaluate(scenario, "${button("[data-connect-sheet] button", "Move session here")}.click()")
                assertTrue("The laptop was never released", released.await(25, TimeUnit.SECONDS))
                waitFor("$devices==='Devices'")
                web.evaluate(scenario, "window.__timer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__local=s),100)")
                waitFor("window.__local?.items?.length===2&&window.__local.index===1&&window.__local.items[1].title==='Peer second'&&window.__local.playWhenReady===true")

                // An independent copy replaces the phone's queue with one track while the laptop keeps playing.
                peerPlaying.set(true)
                publish()
                val beforeCopy = received.size
                web.evaluate(scenario, "document.querySelector('[data-android-devices]').click()")
                val copy = button("[data-connect-sheet] button", "Play a copy here")
                waitFor("!!$copy")
                web.evaluate(scenario, "$copy.click()")
                waitFor("window.__local?.items?.length===1&&window.__local.id==='member-track'&&window.__local.positionMs>=12000&&window.__local.playWhenReady===true")
                assertEquals("Copy sent a command to the laptop", beforeCopy, received.size)
                assertTrue("Copy stopped the laptop", peerPlaying.get())

                val rows = core("/api/devices").getJSONArray("devices")
                assertEquals("WebView registered an extra native playback owner", 1, (0 until rows.length()).count { rows.getJSONObject(it).optString("device_type") == "android" })
            }
        } finally { worker.shutdownNow(); peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }

    private fun entry(queueId: String, title: String) = JSONObject().put("id", "member-track").put("title", title).put("artist", "member artist")
        .put("duration", 600).put("queueId", queueId).put("queueLane", "context").put("queueSource", "album")
}
