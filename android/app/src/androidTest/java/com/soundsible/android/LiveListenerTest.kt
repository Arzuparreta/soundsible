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

/** Independent synthetic publisher -> real relay -> service MediaSession Live player. */
class LiveListenerTest {
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
        var receiving = false
        var hostSocket: NativeCommunitySocket? = null
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
            hostSocket = NativeCommunitySocket(room.getString("socket_url"), mapOf("session_id" to sessionId!!, "host_token" to room.getString("host_token")), android.os.Handler(android.os.Looper.getMainLooper()), { connection.generation == epoch }, { _, _ -> })
            hostSocket.connect()
            await("Synthetic publisher room socket did not connect") { hostSocket.connected() }
            NativeLivePlayer.decodedObservers.add(sink)
            instrumentation.runOnMainSync { active.volume = .8f }
            val selected = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveListen"); putString("session", room.toString()); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, selected.resultCode)
            receiving = true
            await("Relay did not decode programme") { rms.get() > 500 }
            val playing = AtomicReference(false)
            await("MediaSession did not expose Live playback") {
                instrumentation.runOnMainSync { playing.set(active.isPlaying && active.currentMediaItem?.mediaId == "soundsible:live:$sessionId" && !active.isCommandAvailable(androidx.media3.common.Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)) }
                playing.get()
            }
            val thumb = android.graphics.Bitmap.createBitmap(64, 64, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.RED) }
            val artworkUrl = LiveArtwork(room.getString("socket_url"), sessionId!!).use { it.upload(thumb, room.getString("host_token"), "remote-track") }
            thumb.recycle()
            hostSocket.emit("program_event", JSONObject().put("v", 1).put("seq", 1).put("emitted_at", System.currentTimeMillis())
                .put("program_time", 1).put("transport", "playing").put("paused_since", JSONObject.NULL)
                .put("primary", JSONObject().put("id", "remote-track").put("title", "Remote native song").put("artist", "Remote artist").put("artwork_url", artworkUrl).put("position", 0).put("duration", 600).put("gain", 1))
                .put("secondary", JSONObject.NULL).put("transition", JSONObject.NULL))
            await("Guest metadata did not reach MediaSession") {
                instrumentation.runOnMainSync { playing.set(active.mediaMetadata.title?.toString() == "Remote native song") }; playing.get()
            }
            await("Guest public artwork did not reach MediaSession") {
                instrumentation.runOnMainSync { playing.set(active.mediaMetadata.artworkData?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.width == 64 } == true) }; playing.get()
            }
            val chat = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveChat"); putString("text", "Native guest message"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, chat.resultCode)
            await("Native guest chat echo missing") {
                val observed = AtomicReference<String>()
                instrumentation.runOnMainSync { observed.set(active.sessionExtras.getString("nativeLiveListener")) }
                val messages = observed.get()?.let { JSONObject(it).optJSONArray("messages") }
                messages != null && (0 until messages.length()).any { messages.getJSONObject(it).optString("text") == "Native guest message" && messages.getJSONObject(it).getJSONObject("sender").getString("kind") == "guest" }
            }
            // Actual decoded Live is not a source for a new native programme capture.
            LiveProgramInput(connection).use { programme ->
                Thread.sleep(400)
                val encodedSource = ByteArray(1920)
                programme.read(encodedSource, 48000, 2)
                assertTrue("Received Live was recaptured for broadcast", encodedSource.all { it == 0.toByte() })
            }
            instrumentation.runOnMainSync { active.volume = .4f; active.pause() }
            await("MediaSession pause was ignored") {
                instrumentation.runOnMainSync { playing.set(!active.playWhenReady && !active.isPlaying && active.volume == .4f) }; playing.get()
            }
            instrumentation.runOnMainSync { active.play() }
            await("MediaSession resume was ignored") { instrumentation.runOnMainSync { playing.set(active.isPlaying) }; playing.get() }
            scenario.close(); scenario = null
            rms.set(0.0)
            await("Activity close stopped remote programme") { rms.get() > 500 }
            instrumentation.runOnMainSync { active.pause(); active.stop() }
            await("MediaSession stop was ignored") { instrumentation.runOnMainSync { playing.set(active.playbackState == androidx.media3.common.Player.STATE_IDLE && !active.playWhenReady) }; playing.get() }
            instrumentation.runOnMainSync { active.prepare(); active.play() }
            rms.set(0.0)
            await("Manual retry did not recover decoded Live") { rms.get() > 500 }
            val leave = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveLeave"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, leave.resultCode)
            // Canonical car selection returns to NORMAL and releases the Live backend.
            instrumentation.runOnMainSync { active.setMediaItem(song); active.prepare(); active.play() }
            await("Return to local programme failed") { instrumentation.runOnMainSync { playing.set(active.isPlaying && active.currentMediaItem?.mediaId == "member-track") }; playing.get() }
        } finally {
            NativeLivePlayer.decodedObservers.remove(sink)
            hostSocket?.close()
            browser?.let { active -> if (receiving) instrumentation.runOnMainSync { active.pause(); active.stop() } }
            publisher?.close()
            sessionId?.let { request("/api/community/sessions/$it", "DELETE") }
            browser?.let { active -> instrumentation.runOnMainSync { active.release() } }
            scenario?.close()
            connection.clearSession(true)
        }
    }
}
