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

/** Real signed Core -> Community -> TLS WHIP/MediaMTX/WHEP -> decoded native PCM. */
class LiveRelayTest {
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
        var publisher: LivePeer? = null
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
            val room = request("/api/community/sessions", "POST", "{\"title\":\"Isolated native relay\"}").getJSONObject("session")
            sessionId = room.getString("id")
            publisher = LivePeer(context, connection, room.getString("whip_url"), room.getString("publish_token"), true, {})
            publisher.start()
            receiver = LivePeer(context, connection, room.getString("whep_url"), null, false, {}, sink)
            receiver.start()
            await("Relay did not decode programme") { rms.get() > 500 }
            // Rejected second broadcaster must not steal or close the active capture.
            val duplicate = LivePeer(context, connection, room.getString("whip_url"), room.getString("publish_token"), true, {})
            try { duplicate.start(); fail("Second publisher accepted") }
            catch (expected: IllegalStateException) { assertEquals("LIVE_INPUT_IN_USE", expected.message) }
            finally { duplicate.close() }
            rms.set(0.0)
            await("Rejected publisher damaged active capture") { rms.get() > 500 }
            instrumentation.runOnMainSync { active.volume = 0f }
            Thread.sleep(500)
            await("Local mute silenced Live") { rms.get() > 500 }
            instrumentation.runOnMainSync { active.pause() }
            Thread.sleep(500)
            await("Paused programme is not silent remotely") { rms.get() < 20 }
            instrumentation.runOnMainSync { active.play() }
            await("Resume did not recover remote PCM") { rms.get() > 500 }
            scenario.close(); scenario = null
            rms.set(0.0)
            await("Activity close stopped remote programme") { rms.get() > 500 }
        } finally {
            receiver?.close(); publisher?.close()
            sessionId?.let { request("/api/community/sessions/$it", "DELETE") }
            browser?.let { active -> instrumentation.runOnMainSync { active.release() } }
            scenario?.close()
            connection.clearSession(true)
        }
    }
}
