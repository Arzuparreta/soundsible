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

/** Radio keeps generated ownership across handoff; disabled Autoplay removes only its imported runway. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceRadioSessionTest {
    @Test fun httpRadioDevice() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsRadioDevice() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context); connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "device-radio-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); assertEquals("$path: $text", 200, it.code); if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        core("/api/discovery/settings", "PATCH", JSONObject().put("autoplay_enabled", false))
        fun <T> main(work: () -> T): T { val value = AtomicReference<T>(); instrumentation.runOnMainSync { value.set(work()) }; return value.get() }
        fun await(label: String, condition: () -> Boolean) { val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label) }
        val peerId = java.util.UUID.randomUUID().toString(); val client = connection.client; val transferred = AtomicReference<JSONObject>()
        val peer = io.socket.client.IO.socket(origin, io.socket.client.IO.Options().apply { forceNew = true; reconnection = false
            callFactory = client; webSocketFactory = client; extraHeaders = mapOf("Cookie" to listOf(connection.cookieHeader(epoch)!!)) })
        peer.on(io.socket.client.Socket.EVENT_CONNECT) { peer.emit("playback_register", JSONObject().put("device_id", peerId).put("device_name", "Radio peer").put("device_type", "desktop")) }
        peer.on("playback_start_requested") { args -> transferred.set(args.firstOrNull() as? JSONObject) }
        var scenario: ActivityScenario<MainActivity>? = null; var browser: MediaBrowser? = null; var capture: ProgramPcmTap.Capture? = null
        val pcm = AtomicBoolean()
        try {
            peer.connect(); scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            await("Native device not ready") { main { active.sessionExtras.getString("nativeDevice") }?.let { JSONObject(it).optBoolean("connected") } == true }
            val id = JSONObject(main { active.sessionExtras.getString("nativeDevice") }!!).getString("device_id")
            await("Radio peer not ready") { val devices = core("/api/devices").getJSONArray("devices")
                (0 until devices.length()).any { devices.getJSONObject(it).let { row -> row.optString("device_id") == peerId && row.optBoolean("socket_active") } } }
            val queue = JSONArray()
            for (i in 0..9) queue.put(JSONObject().put("id", "member-track").put("title", if (i == 2) "Manual survivor" else "Radio $i")
                .put("artist", "member artist").put("queueId", "radio-$i").put("queueLane", when (i) { 0 -> "context"; 2 -> "manual"; else -> "generated" })
                .put("queueSource", if (i == 2) "library" else "radio"))
            val radio = JSONObject().put("active", true).put("seedId", "member-track").put("profile", "explore")
                .put("seed", JSONObject().put("id", "member-track").put("track_id", "member-track").put("title", "Seed"))
            val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", queue).put("index", 1)
                .put("shuffle", false).put("repeat", "off").put("radio", radio).put("auto", JSONObject.NULL)
            fun incoming(snapshot: JSONObject, index: Int) {
                core("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", "member-track")
                    .put("track", snapshot.getJSONArray("queue").getJSONObject(index)).put("position_sec", 2).put("is_playing", false).put("session", snapshot))
                core("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            }
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            incoming(session, 1)
            await("Incoming Radio did not restore PCM/queue/index/intent") { main { active.mediaItemCount == 10 && active.currentMediaItemIndex == 1 && active.sessionExtras.getBoolean("radioActive") && active.isPlaying } && pcm.get() }
            scenario.close(); scenario = null
            main { active.pause() }
            await("Radio state not published") { core("/api/playback/state").optJSONObject("session")?.optJSONObject("radio")?.optBoolean("active") == true }
            transferred.set(null)
            val result = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "deviceHandoff"); putLong("generation", epoch); putString("device_id", peerId) }) }.get(20, TimeUnit.SECONDS)
            assertEquals(0, result.resultCode)
            await("Radio outgoing intent missing") { transferred.get()?.optJSONObject("state")?.optJSONObject("session")?.optJSONObject("radio")?.optBoolean("active") == true }
            val returned = transferred.get()!!.getJSONObject("state").getJSONObject("session")
            assertEquals("explore", returned.getJSONObject("radio").getString("profile")); assertEquals("member-track", returned.getJSONObject("radio").getString("seedId"))
            val wire = returned.getJSONArray("queue")
            assertEquals(8, (0 until wire.length()).count { wire.getJSONObject(it).getString("queueLane") == "generated" })
            val key = main { ProgramQueue.key(active, 1) }
            val stopped = main { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "radio"); putLong("generation", epoch); putBoolean("enabled", false)
                putString("queueToken", ProgramQueue.token(active)); putString("key", key)
            }) }.get(15, TimeUnit.SECONDS)
            assertEquals(0, stopped.resultCode)
            await("Stop Radio lost manual queue or kept generated future") { main { !active.sessionExtras.getBoolean("radioActive") && active.mediaItemCount == 3 && active.getMediaItemAt(2).mediaMetadata.title.toString() == "Manual survivor" } }
            assertEquals(key, main { ProgramQueue.key(active, 1) })
            // Importing Autoplay is governed by the receiver's confirmed account setting.
            val automatic = JSONArray().put(JSONObject().put("id", "member-track").put("title", "Current").put("queueId", "auto-current").put("queueLane", "manual").put("queueSource", "library"))
                .put(JSONObject().put("id", "member-track").put("title", "Keep manual").put("queueId", "auto-manual").put("queueLane", "manual").put("queueSource", "library"))
            for (i in 0..1) automatic.put(JSONObject().put("id", "member-track").put("title", "Generated $i").put("queueId", "auto-generated-$i").put("queueLane", "generated").put("queueSource", "autoplay"))
            val next = JSONObject(session.toString()).put("queue", automatic).put("index", 0).put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL))
            incoming(next, 0)
            await("Disabled Autoplay failed to remove only its imported future") { main { active.mediaItemCount == 2 && active.getMediaItemAt(1).mediaMetadata.title.toString() == "Keep manual" && active.sessionExtras.getString("autoplaySettingsPhase") == "ready" && !active.sessionExtras.getBoolean("autoplayEnabled") } }
        } finally { capture?.close(); main { browser?.release() }; scenario?.close(); peer.off(); peer.disconnect(); connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
    }
}
