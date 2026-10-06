package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/** Shared auto workspace enters and leaves the native dual-decoder programme through real Core. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceDjSessionTest {
    @Test fun httpDjDevice() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsDjDevice() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "device-dj-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); assertEquals("$path: $text", 200, it.code); if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        fun <T> main(work: () -> T): T { val result = AtomicReference<T>(); instrumentation.runOnMainSync { result.set(work()) }; return result.get() }
        fun await(label: String, condition: () -> Boolean) { val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label) }
        val peerId = java.util.UUID.randomUUID().toString(); val client = connection.client
        val transferred = AtomicReference<JSONObject>()
        val peer = io.socket.client.IO.socket(origin, io.socket.client.IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(io.socket.client.Socket.EVENT_CONNECT) { peer.emit("playback_register", JSONObject().put("device_id", peerId).put("device_name", "DJ peer").put("device_type", "desktop")) }
        peer.on("playback_start_requested") { args -> transferred.set(args.firstOrNull() as? JSONObject) }
        var scenario: ActivityScenario<MainActivity>? = null; var browser: MediaBrowser? = null; var capture: ProgramPcmTap.Capture? = null
        val pcm = AtomicBoolean()
        try {
            peer.connect(); scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            await("Native account device not ready") { main { active.sessionExtras.getString("nativeDevice") }?.let { JSONObject(it).optBoolean("connected") } == true }
            val id = JSONObject(main { active.sessionExtras.getString("nativeDevice") }!!).getString("device_id")
            await("Peer socket not registered") { val devices = core("/api/devices").getJSONArray("devices")
                (0 until devices.length()).any { devices.getJSONObject(it).let { row -> row.optString("device_id") == peerId && row.optBoolean("socket_active") } } }
            val queue = JSONArray()
            for (i in 0..7) queue.put(JSONObject().put("id", "member-track").put("title", "Remote DJ $i").put("artist", "member artist").put("duration", 600)
                .put("queueId", "remote-$i").put("queueLane", if (i == 4) "manual" else "generated").put("queueSource", "auto_mode")
                .put("autoRoute", JSONObject().put("kind", when (i) { 3 -> "bridge"; 4 -> "user"; else -> "generated" }).apply { if (i == 3) put("ownerQueueId", "remote-4") }))
            val source = JSONObject().put("id", "direction-source").put("label", "Direction fixture").put("activation", 7)
                .put("tracks", JSONArray().put(JSONObject().put("id", "member-track").put("title", "Source song").put("artist", "member artist")))
            val transition = JSONObject().put("technique", "safe_fade").put("out_cue", 300).put("in_cue", 0).put("overlap_seconds", 6)
                .put("playback_rate", 1).put("confidence", 0.9)
            val workspace = JSONObject().put("profile", "balanced").put("djProfile", "cuts_drops").put("direction", JSONObject().put("energy", 0.4))
                .put("sourcePolicy", "explicit").put("sources", JSONArray().put(source)).put("heard", JSONArray().put(JSONObject().put("id", "heard-before")))
                .put("avoidedIdentities", JSONArray().put("music:track:avoided-before")).put("exploration", JSONArray()).put("directionRevision", 7)
                .put("staleSeams", JSONArray()).put("plan", JSONObject().put("remote-2", JSONObject().put("trackId", "member-track").put("source", "local")
                    .put("reasonKey", "autoMode.reason.library").put("sourceSetLabel", "Direction fixture").put("fromKey", "member-track").put("transition", transition)))
            val session = JSONObject().put("v", 1).put("mode", "auto").put("queue", queue).put("index", 1).put("shuffle", false).put("repeat", "off")
                .put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", workspace)
            core("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", "member-track").put("track", queue.getJSONObject(1))
                .put("position_sec", 2).put("is_playing", false).put("session", session))
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            core("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            await("DJ handoff did not restore native PCM/index/workspace") { main { active.sessionExtras.getBoolean("djActive") && active.mediaItemCount == 8 && active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Remote DJ 1" && active.isPlaying } && pcm.get() }
            scenario.close(); scenario = null
            fun remote(command: String, body: JSONObject = JSONObject()) = core("/api/playback/remote-command", "POST", body.put("device_id", id).put("command", command))
            remote("pause"); await("DJ background pause failed") { main { !active.playWhenReady } }
            val key = main { ProgramQueue.key(active, 1) }
            await("DJ workspace not published") { core("/api/playback/state").optJSONObject("session")?.optString("mode") == "auto" }
            val published = core("/api/playback/state").getJSONObject("session")
            val auto = published.getJSONObject("auto")
            assertEquals("cuts_drops", auto.getString("djProfile")); assertEquals(0.4, auto.getJSONObject("direction").getDouble("energy"), 0.0001)
            assertEquals("Direction fixture", auto.getJSONArray("sources").getJSONObject(0).getString("label"))
            assertEquals("explicit", auto.getString("sourcePolicy")); assertTrue(auto.getJSONArray("heard").toString().contains("heard-before"))
            assertTrue(auto.getJSONArray("avoidedIdentities").toString().contains("avoided-before"))
            val wireQueue = published.getJSONArray("queue")
            assertEquals(wireQueue.getJSONObject(4).getString("queueId"), wireQueue.getJSONObject(3).getJSONObject("autoRoute").getString("ownerQueueId"))
            val planned = auto.getJSONObject("plan").getJSONObject(wireQueue.getJSONObject(2).getString("queueId"))
            assertEquals("member-track", planned.getString("fromKey")); assertEquals("Direction fixture", planned.getString("sourceSetLabel"))
            remote("play"); pcm.set(false); await("DJ remote resume did not restore PCM") { main { active.isPlaying } && pcm.get() }
            assertEquals("DJ remote resume replaced occurrence", key, main { ProgramQueue.key(active, 1) })
            remote("seek", JSONObject().put("position_sec", 3)); await("DJ remote seek failed") { main { active.currentPosition in 3000..7000 } }
            remote("next"); await("DJ remote next failed") { main { active.currentMediaItemIndex == 2 } }
            remote("previous"); await("DJ remote previous failed") { main { active.currentMediaItemIndex == 1 } }
            remote("pause"); await("DJ did not pause before outgoing handoff") { main { !active.playWhenReady } }
            transferred.set(null)
            val result = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "deviceHandoff"); putLong("generation", epoch); putString("device_id", peerId) }) }.get(20, TimeUnit.SECONDS)
            assertEquals("Native DJ outgoing handoff failed", 0, result.resultCode)
            await("Peer did not receive DJ workspace") { transferred.get()?.optJSONObject("state")?.optJSONObject("session")?.optString("mode") == "auto" }
            assertEquals("cuts_drops", transferred.get()!!.getJSONObject("state").getJSONObject("session").getJSONObject("auto").getString("djProfile"))
            assertFalse("Native credentials entered public workspace", transferred.get().toString().contains("sb_session"))
            assertFalse(main { active.playWhenReady })
            // The peer edits the workspace while retaining this queue's original occurrence IDs.
            val returned = JSONObject(transferred.get()!!.getJSONObject("state").toString()).put("device_id", peerId).put("position_sec", 2)
            returned.getJSONObject("session").getJSONObject("auto").getJSONObject("direction").put("energy", 0.8)
            returned.getJSONObject("session").getJSONObject("auto").getJSONArray("sources").getJSONObject(0).put("label", "Updated direction")
            core("/api/playback/state", "PUT", returned)
            pcm.set(false)
            core("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            await("Returned same-queue handoff ignored changed DJ direction") {
                val received = core("/api/playback/state").optJSONObject("session")?.optJSONObject("auto")
                received?.optJSONObject("direction")?.optDouble("energy") == 0.8 && received.optJSONArray("sources")?.optJSONObject(0)?.optString("label") == "Updated direction" && main { active.isPlaying } && pcm.get()
            }
            remote("pause"); await("Returned DJ pause failed") { main { !active.playWhenReady } }
            val validKey = main { ProgramQueue.key(active, active.currentMediaItemIndex) }
            val bad = JSONObject(returned.toString())
            bad.getJSONObject("session").getJSONObject("auto").put("djProfile", "unsupported")
            core("/api/playback/state", "PUT", bad)
            core("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            await("Invalid workspace did not leave the valid native workspace intact") { core("/api/playback/state").optJSONObject("session")?.optJSONObject("auto")?.optString("djProfile") == "cuts_drops" }
            assertEquals(validKey, main { ProgramQueue.key(active, active.currentMediaItemIndex) })
            assertFalse("Malformed handoff resumed paused native programme", main { active.playWhenReady })

        } finally { capture?.close(); main { browser?.release() }; scenario?.close(); peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
