package com.soundsible.android

import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import io.socket.client.Ack
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Shared auto workspace enters and leaves the native dual-decoder programme through real Core. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceDjSessionTest {
    @Test fun httpDjDevice() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsDjDevice() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null, expected: Int = 200): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "device-dj-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); assertEquals("$path: $text", expected, it.code); if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        fun <T> main(work: () -> T): T { val result = AtomicReference<T>(); instrumentation.runOnMainSync { result.set(work()) }; return result.get() }
        fun await(label: String, condition: () -> Boolean) { val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label) }
        val peerId = java.util.UUID.randomUUID().toString()
        val peerInstance = java.util.UUID.randomUUID().toString()
        val peerSeq = AtomicLong(0)
        val peerState = AtomicReference<JSONObject>()
        val client = connection.client
        val transferred = AtomicReference<JSONObject>()
        val peer = io.socket.client.IO.socket(origin, io.socket.client.IO.Options().apply {
            forceNew = true; reconnection = false; callFactory = client; webSocketFactory = client
            extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!))
        })
        peer.on(io.socket.client.Socket.EVENT_CONNECT) {
            peer.emit("playback_register", JSONObject()
                .put("device_id", peerId).put("device_name", "DJ peer").put("device_type", "desktop")
                .put("form_factor", "computer").put("instance_id", peerInstance).put("protocol", 1)
                .put("commands", JSONArray(listOf("session.export", "session.import", "session.release"))))
        }
        peer.on("device_command") { arguments ->
            val payload = arguments.firstOrNull() as? JSONObject ?: return@on
            val ack = arguments.lastOrNull() as? Ack
            when (payload.optString("name")) {
                "session.export" -> {
                    val state = peerState.get()
                    if (state != null) ack?.call(JSONObject().put("status", "applied").put("state", state))
                    else ack?.call(JSONObject().put("status", "rejected").put("reason", "nothing_playing"))
                }
                "session.import" -> {
                    transferred.set(payload.optJSONObject("args")?.optJSONObject("state"))
                    ack?.call(JSONObject().put("status", "applied").put("rev", 1))
                }
                "session.release" -> ack?.call(JSONObject().put("status", "applied").put("rev", 2))
                else -> ack?.call(JSONObject().put("status", "rejected").put("reason", "unsupported"))
            }
        }
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
                .put("autoRoute", JSONObject().put("kind", when (i) { 3 -> "bridge"; 4 -> "user"; else -> "generated" }).apply { if (i == 3) put("ownerQueueId", "remote-4"); if (i == 4) put("requestGroup", "remote-collection") }))
            val source = JSONObject().put("id", "direction-source").put("label", "Direction fixture").put("activation", 7)
                .put("tracks", JSONArray().put(JSONObject().put("id", "member-track").put("title", "Source song").put("artist", "member artist")))
            val transition = JSONObject().put("technique", "safe_fade").put("out_cue", 300).put("in_cue", 0).put("overlap_seconds", 6)
                .put("playback_rate", 1).put("confidence", 0.9)
            // Written by an older client: a DJ style and a direction no longer exist and are dropped.
            val workspace = JSONObject().put("profile", "balanced").put("djProfile", "cuts_drops").put("direction", JSONObject().put("energy", 0.4))
                .put("sourcePolicy", "explicit").put("sources", JSONArray().put(source)).put("heard", JSONArray().put(JSONObject().put("id", "heard-before")))
                .put("avoidedIdentities", JSONArray().put("music:track:avoided-before")).put("exploration", JSONArray()).put("directionRevision", 7)
                .put("staleSeams", JSONArray()).put("plan", JSONObject().put("remote-2", JSONObject().put("trackId", "member-track").put("source", "local")
                    .put("reasonKey", "autoMode.reason.library").put("sourceSetLabel", "Direction fixture").put("fromKey", "member-track").put("transition", transition)))
            val session = JSONObject().put("v", 1).put("mode", "auto").put("queue", queue).put("index", 1).put("shuffle", false).put("repeat", "off")
                .put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", workspace)
            fun publishPeer(state: JSONObject) {
                peerState.set(state)
                core("/api/playback/state", "PUT", JSONObject(state.toString())
                    .put("instance_id", peerInstance).put("seq", peerSeq.incrementAndGet()))
            }
            publishPeer(JSONObject().put("device_id", peerId).put("track_id", "member-track").put("track", queue.getJSONObject(1))
                .put("position_sec", 2).put("is_playing", false).put("session", session))
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            val entered = core("/api/devices/transfer", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            assertEquals("applied", entered.optString("status"))
            await("DJ transfer did not restore native PCM/index/workspace") { main { active.sessionExtras.getBoolean("djActive") && active.mediaItemCount == 8 && active.currentMediaItemIndex == 1 && active.mediaMetadata.title.toString() == "Remote DJ 1" && active.isPlaying } && pcm.get() }
            scenario.close(); scenario = null
            fun remote(name: String, args: JSONObject = JSONObject(), expected: Int = 200) =
                core("/api/devices/$id/commands", "POST", JSONObject().put("name", name).put("args", args), expected = expected)
            assertEquals("applied", remote("transport.pause").optString("status"))
            await("DJ background pause failed") { main { !active.playWhenReady } }
            val key = main { ProgramQueue.key(active, 1) }
            await("DJ workspace not published") { core("/api/playback/state").optJSONObject("session")?.optString("mode") == "auto" }
            val published = core("/api/playback/state").getJSONObject("session")
            val auto = published.getJSONObject("auto")
            assertFalse(auto.has("djProfile")); assertFalse(auto.has("direction"))
            assertEquals("Direction fixture", auto.getJSONArray("sources").getJSONObject(0).getString("label"))
            assertEquals("explicit", auto.getString("sourcePolicy")); assertTrue(auto.getJSONArray("heard").toString().contains("heard-before"))
            assertTrue(auto.getJSONArray("avoidedIdentities").toString().contains("avoided-before"))
            val wireQueue = published.getJSONArray("queue")
            assertEquals(wireQueue.getJSONObject(4).getString("queueId"), wireQueue.getJSONObject(3).getJSONObject("autoRoute").getString("ownerQueueId"))
            assertEquals("remote-collection", wireQueue.getJSONObject(4).getJSONObject("autoRoute").getString("requestGroup"))
            val planned = auto.getJSONObject("plan").getJSONObject(wireQueue.getJSONObject(2).getString("queueId"))
            assertEquals("member-track", planned.getString("fromKey")); assertEquals("Direction fixture", planned.getString("sourceSetLabel"))
            pcm.set(false)
            assertEquals("applied", remote("transport.play").optString("status"))
            await("DJ remote resume did not restore PCM") { main { active.isPlaying } && pcm.get() }
            assertEquals("DJ remote resume replaced occurrence", key, main { ProgramQueue.key(active, 1) })
            assertEquals("applied", remote("transport.seek", JSONObject().put("position_sec", 3)).optString("status"))
            await("DJ remote seek failed") { main { active.currentPosition in 3000..7000 } }
            assertEquals("applied", remote("transport.next").optString("status"))
            await("DJ remote next failed") { main { active.currentMediaItemIndex == 2 } }
            assertEquals("applied", remote("transport.previous").optString("status"))
            await("DJ remote previous failed") { main { active.currentMediaItemIndex == 1 } }
            // DJ route edit by command: move unlocked entry, remove unlocked entry, reject locked and missing entries.
            val key5 = main { ProgramQueue.key(active, 5) }
            val key6 = main { ProgramQueue.key(active, 6) }
            val key7 = main { ProgramQueue.key(active, 7) }
            val moved = remote("queue.move", JSONObject().put("queue_id", key7).put("before_queue_id", key5))
            assertEquals("applied", moved.optString("status"))
            await("DJ remote move did not reorder route") { main { ProgramQueue.key(active, 5) == key7 && ProgramQueue.key(active, 6) == key5 } }
            assertEquals("applied", remote("queue.remove", JSONObject().put("queue_id", key6)).optString("status"))
            await("DJ remote remove did not drop entry") { main { active.mediaItemCount == 7 } }
            val lockedRemove = remote("queue.remove", JSONObject().put("queue_id", key), expected = 409)
            assertEquals("rejected", lockedRemove.optString("status")); assertEquals("locked", lockedRemove.optString("reason"))
            val missingRemove = remote("queue.remove", JSONObject().put("queue_id", "no-such-dj-entry"), expected = 409)
            assertEquals("rejected", missingRemove.optString("status")); assertEquals("not_found", missingRemove.optString("reason"))
            assertEquals("applied", remote("transport.pause").optString("status"))
            await("DJ did not pause before outgoing handoff") { main { !active.playWhenReady } }
            transferred.set(null)
            val result = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "deviceHandoff"); putLong("generation", epoch); putString("device_id", peerId) }) }.get(20, TimeUnit.SECONDS)
            assertEquals("Native DJ outgoing handoff failed", 0, result.resultCode)
            await("Peer did not receive DJ workspace") { transferred.get()?.optJSONObject("session")?.optString("mode") == "auto" }
            assertEquals("Direction fixture", transferred.get()!!.getJSONObject("session").getJSONObject("auto").getJSONArray("sources").getJSONObject(0).getString("label"))
            assertEquals("remote-collection", transferred.get()!!.getJSONObject("session").getJSONArray("queue").getJSONObject(4).getJSONObject("autoRoute").getString("requestGroup"))
            assertFalse("Native credentials entered public workspace", transferred.get().toString().contains("sb_session"))
            assertFalse(main { active.playWhenReady })
            // The peer edits the workspace while retaining this queue's original occurrence IDs.
            val returned = JSONObject(transferred.get()!!.toString()).put("device_id", peerId).put("position_sec", 2)
            returned.getJSONObject("session").getJSONObject("auto").getJSONArray("sources").getJSONObject(0).put("label", "Updated direction")
            publishPeer(returned)
            pcm.set(false)
            assertEquals("applied", core("/api/devices/transfer", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id)).optString("status"))
            await("Returned same-queue transfer ignored changed DJ sources") {
                val received = core("/api/playback/state").optJSONObject("session")?.optJSONObject("auto")
                received?.optJSONArray("sources")?.optJSONObject(0)?.optString("label") == "Updated direction" && main { active.isPlaying } && pcm.get()
            }
            assertEquals("applied", remote("transport.pause").optString("status"))
            await("Returned DJ pause failed") { main { !active.playWhenReady } }
            val validKey = main { ProgramQueue.key(active, active.currentMediaItemIndex) }
            val bad = JSONObject(returned.toString())
            // More sources than a workspace holds.
            bad.getJSONObject("session").getJSONObject("auto").put("sources", JSONArray().apply { repeat(7) { put(JSONObject(source.toString()).put("id", "too-many-$it")) } })
            publishPeer(bad)
            val rejected = core("/api/devices/transfer", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id), expected = 409)
            assertEquals("rejected", rejected.optString("status"))
            // The account's newest publication is now the peer's invalid one: read the native workspace itself.
            await("Invalid workspace did not leave the valid native workspace intact") {
                main { active.sessionExtras.getString("djSources") }?.let { JSONArray(it).optJSONObject(0)?.optString("label") } == "Updated direction"
            }
            assertEquals(validKey, main { ProgramQueue.key(active, active.currentMediaItemIndex) })
            assertFalse("Malformed transfer resumed paused native programme", main { active.playWhenReady })
            // play.tracks during DJ mode starts a fresh DJ selection instead of exiting DJ mode.
            val selection = remote("play.tracks", JSONObject()
                .put("tracks", JSONArray().put(JSONObject().put("id", "member-track").put("title", "Remote DJ selection").put("artist", "member artist").put("duration", 600)))
                .put("index", 0))
            assertEquals("applied", selection.optString("status"))
            await("play.tracks during DJ mode did not continue DJ session") {
                main { active.sessionExtras.getBoolean("djActive") && active.mediaMetadata.title.toString() == "Remote DJ selection" }
            }
        } finally { capture?.close(); main { browser?.release() }; scenario?.close(); peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
