package com.soundsible.android

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ActivityScenario
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.webrtc.AudioTrackSink
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.sqrt

/** Service-owned room lease and metadata survive Activity; real Community/relay. */
class LiveHostTest {
    @Test fun httpCoreRelay() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsCoreRelay() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val epoch = connection.configure(origin)
        fun request(path: String, method: String, json: String? = null): JSONObject =
            connection.execute(path, method, json?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-relay", 15000).use {
                val text = it.body?.string().orEmpty()
                check(it.isSuccessful) { "Core $path: ${it.code} $text" }
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        request("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}")
        // The principal runner must opt into the isolated relay; never use the official service.
        val configuration = request("/api/community/config", "GET")
        assertEquals("Isolated Live fixture required", "https://10.0.2.2:58443", configuration.optString("api_url"))
        var scenario: ActivityScenario<MainActivity>? = null
        var browser: MediaBrowser? = null
        var started = false
        var receiver: LivePeer? = null
        var sessionId: String? = null
        fun <T> call(work: () -> com.google.common.util.concurrent.ListenableFuture<T>): T {
            val future = AtomicReference<com.google.common.util.concurrent.ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }
            return future.get().get(15, TimeUnit.SECONDS)
        }
        fun await(label: String, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }
            fail(label)
        }
        val rms = AtomicReference(0.0)
        val sink = AudioTrackSink { data, bits, rate, channels, frames, _ ->
            if (bits == 16 && rate == 48000 && channels >= 1 && frames > 0) {
                val samples = data.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN)
                var squares = 0.0; var count = 0
                while (samples.remaining() >= 2) { val value = samples.short.toDouble(); squares += value * value; count++ }
                if (count > 0) rms.set(sqrt(squares / count))
            }
        }
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = call { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }
            browser = active
            val songs = call { active.getChildren("all-tracks", 0, 200, null) }.value!!
            val song = songs.single { it.mediaId == "soundsible:track:member-track" }
            instrumentation.runOnMainSync { active.setMediaItem(song); active.prepare(); active.play() }
            await("Native programme not playing") { NativeProgramOutput.playing }
            val programmeKey = AtomicReference<String>()
            instrumentation.runOnMainSync { programmeKey.set(ProgramQueue.key(active, active.currentMediaItemIndex)) }
            assertFalse(programmeKey.get().isBlank())
            val start = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveStart"); putString("title", "Service background host"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, start.resultCode)
            started = true
            val room = JSONObject(start.extras.getString("liveSession")!!)
            assertFalse(room.has("host_token")); assertFalse(room.has("publish_token")); assertFalse(room.has("whip_url"))
            sessionId = room.getString("id")
            val publicClient = okhttp3.OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
            fun publicRoom(): JSONObject = publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/v1/sessions/$sessionId").build()).execute().use {
                check(it.isSuccessful); JSONObject(it.body!!.string()).getJSONObject("session")
            }
            receiver = LivePeer(context, connection, room.getString("whep_url"), null, false, {}, sink)
            receiver.start()
            await("Relay did not decode programme") { rms.get() > 500 }
            await("Host did not publish authoritative metadata") {
                val programme = publicRoom().optJSONObject("program")
                programme?.optJSONObject("primary")?.optString("id") == "member-track" && programme.optString("transport") == "playing"
            }
            val previousSequence = publicRoom().getJSONObject("program").getLong("seq")
            val title = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveTitle"); putString("title", "Updated native host"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, title.resultCode)
            assertEquals("Updated native host", publicRoom().getString("title"))
            val chat = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveChat"); putString("text", "Native host message"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, chat.resultCode)
            await("Native chat echo missing") {
                val observed = AtomicReference<String>()
                instrumentation.runOnMainSync { observed.set(active.sessionExtras.getString("nativeLiveHost")) }
                val messages = observed.get()?.let { JSONObject(it).optJSONArray("messages") }
                messages != null && (0 until messages.length()).any { messages.getJSONObject(it).optString("text") == "Native host message" }
            }
            instrumentation.runOnMainSync { active.volume = 0f }
            Thread.sleep(500)
            await("Local mute silenced Live") { rms.get() > 500 }
            instrumentation.runOnMainSync { active.pause() }
            Thread.sleep(500)
            await("Paused programme is not silent remotely") { rms.get() < 20 }
            await("Paused metadata did not reach relay") { publicRoom().optJSONObject("program")?.optString("transport") == "paused" }
            instrumentation.runOnMainSync { active.play() }
            await("Resume did not recover remote PCM") { rms.get() > 500 }
            scenario.close(); scenario = null
            rms.set(0.0)
            await("Activity close stopped remote programme") { rms.get() > 500 }
            await("Room heartbeat stopped with Activity") { publicRoom().getJSONObject("program").getLong("seq") > previousSequence + 2 }
            val stop = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveStop"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, stop.resultCode)
            started = false
            publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/v1/sessions/$sessionId").build()).execute().use { assertEquals(404, it.code) }
            val stillPlaying = AtomicReference(false)
            instrumentation.runOnMainSync { stillPlaying.set(active.isPlaying && ProgramQueue.key(active, active.currentMediaItemIndex) == programmeKey.get()) }
            assertTrue("Ending Live stopped local programme", stillPlaying.get())
            publicClient.connectionPool.evictAll(); publicClient.dispatcher.executorService.shutdown()
        } finally {
            receiver?.close()
            if (started) browser?.let { active -> call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "liveStop"); putLong("generation", epoch) }) } }
            browser?.let { active -> instrumentation.runOnMainSync { active.release() } }
            scenario?.close()
            connection.clearSession(true)
        }
    }
}
