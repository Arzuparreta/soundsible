package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** A signed resume retires the actual previous relay publisher before Android adopts the room. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LiveResumeTest {
    @Test fun httpResume() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsResume() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val epoch = connection.configure(origin)
        fun core(path: String, method: String, value: JSONObject? = null): JSONObject = connection.execute(path, method,
            (value ?: if (method == "POST") JSONObject() else null)?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-resume", 15000).use {
            check(it.isSuccessful) { "Core $path: ${it.code}" }; it.body?.string()?.takeIf(String::isNotBlank)?.let(::JSONObject) ?: JSONObject()
        }
        fun await(label: String, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(100) }
            fail(label)
        }
        fun <T> call(work: () -> com.google.common.util.concurrent.ListenableFuture<T>): T {
            val future = AtomicReference<com.google.common.util.concurrent.ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }; return future.get().get(20, TimeUnit.SECONDS)
        }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        val room = core("/api/community/sessions", "POST", JSONObject().put("title", "Resume relay owner")).getJSONObject("session")
        val id = room.getString("id")
        val client = okhttp3.OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
        fun public(path: String): JSONObject = client.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443$path")
            .header("X-Android-Fixture", "isolated").build()).execute().use { check(it.isSuccessful); JSONObject(it.body!!.string()) }
        var publisher: LivePeer? = null
        var socket: NativeCommunitySocket? = null
        var scenario: ActivityScenario<MainActivity>? = null
        var browser: MediaBrowser? = null
        var adopted = false
        try {
            var frame = 0L
            val input = org.webrtc.audio.WebRtcAudioRecord.ProgramInput { bytes, rate, channels ->
                for (offset in bytes.indices step channels * 2) {
                    val value = (6000 * kotlin.math.sin(2 * Math.PI * 440 * frame / rate)).toInt()
                    for (channel in 0 until channels) { bytes[offset + channel * 2] = value.toByte(); bytes[offset + channel * 2 + 1] = (value shr 8).toByte() }
                    frame++
                }
            }
            publisher = LivePeer(context, connection, room.getString("whip_url"), room.getString("publish_token"), true, {}, inputFactory = { input })
            publisher.start()
            socket = NativeCommunitySocket(room.getString("socket_url"), mapOf("session_id" to id, "host_token" to room.getString("host_token")),
                android.os.Handler(android.os.Looper.getMainLooper()), { connection.generation == epoch }, { _, _ -> })
            socket.connect(); socket.awaitConnected()
            socket.emit("program_event", JSONObject().put("v", 1).put("seq", 100).put("emitted_at", System.currentTimeMillis())
                .put("program_time", 100).put("transport", "playing").put("primary", JSONObject.NULL).put("secondary", JSONObject.NULL).put("transition", JSONObject.NULL))
            await("Old publisher did not occupy the real relay") { public("/__fixture/relay-state?session_id=$id").getInt("publishers") == 1 }
            await("Previous programme sequence missing") { public("/v1/sessions/$id").getJSONObject("session").optJSONObject("program")?.optLong("seq") == 100L }
            val resumed = core("/api/community/sessions/$id/resume", "POST").getJSONObject("session")
            assertEquals(id, resumed.getString("id")); assertNotEquals(room.getString("publish_token"), resumed.getString("publish_token"))
            await("Signed resume did not retire its old publisher") { public("/__fixture/relay-state?session_id=$id").getInt("publishers") == 0 }
            await("Previous host socket retained ownership") { socket?.connected() != true }
            // Only now retire local SDK objects; the API observation above proves server teardown independently.
            publisher.close(); publisher = null; socket.close(); socket = null
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = call { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }
            browser = active
            val song = call { active.getChildren("all-tracks", 0, 200, null) }.value!!.single { it.mediaId == "soundsible:track:member-track" }
            instrumentation.runOnMainSync { active.setMediaItem(song); active.prepare(); active.play() }
            await("Native programme unavailable") { NativeProgramOutput.playing }
            val start = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveStart"); putString("title", "Adopt existing room"); putLong("generation", epoch)
            }) }
            assertEquals(0, start.resultCode); adopted = true
            assertEquals(id, JSONObject(start.extras.getString("liveSession")!!).getString("id"))
            await("Resumed host did not advance the old sequence") {
                val programme = public("/v1/sessions/$id").getJSONObject("session").optJSONObject("program")
                programme?.optLong("seq", 0)?.let { it > 100 } == true && programme.optJSONObject("primary")?.optString("id") == "member-track" && programme.optString("transport") == "playing"
            }
            connection.execute("/api/community/sessions/$id", "DELETE", JSONObject().put("if_host_token", room.getString("host_token")).toString()
                .toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "stale-host-cleanup", 15000).use { assertEquals(409, it.code) }
            assertEquals(id, public("/v1/sessions/$id").getJSONObject("session").getString("id"))
            assertEquals(0, call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "liveStop"); putLong("generation", epoch) }) }.resultCode)
            adopted = false
        } finally {
            publisher?.close(); socket?.close()
            browser?.let { active ->
                if (adopted) runCatching { call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "liveStop"); putLong("generation", epoch) }) } }
                instrumentation.runOnMainSync { active.release() }
            }
            runCatching { core("/api/community/sessions/$id", "DELETE") }
            scenario?.close(); connection.clearSession(true)
            client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }
}
