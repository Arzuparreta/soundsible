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
    @Test fun httpDjRelay() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!, true)
    @Test fun tlsDjRelay() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!, true)
    @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
    private fun run(origin: String, dj: Boolean = false) {
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
            if (dj) {
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                    .post("{\"album\":true,\"firstFrequency\":440,\"firstDuration\":20,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody("application/json".toMediaType())).build())
                    .execute().use { assertEquals(200, it.code) }
                assertEquals(0, call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                    putString("action", "mixing"); putBoolean("enabled", true); putLong("generation", epoch)
                }) }.resultCode)
                assertEquals(0, call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                    putString("action", "queue"); putLong("generation", epoch); putInt("index", 0)
                    putString("tracks", "[{\"source\":\"local\",\"id\":\"member-pcm-soft\",\"title\":\"DJ outgoing\",\"duration\":20}]")
                }) }.resultCode)
                val queueReady = AtomicReference(false)
                await("DJ seed not playing") { instrumentation.runOnMainSync { queueReady.set(active.isPlaying && active.currentMediaItem?.mediaId == "member-pcm-soft") }; queueReady.get() }
                assertEquals(0, call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                    putString("action", "dj"); putBoolean("fromCurrent", true); putString("profile", "adaptive"); putLong("generation", epoch)
                    putString("queueToken", ProgramQueue.token(active)); putString("key", ProgramQueue.key(active, active.currentMediaItemIndex))
                    putString("sources", "[{\"id\":\"pcm\",\"label\":\"PCM\",\"activation\":0,\"tracks\":[{\"id\":\"member-pcm-soft\",\"title\":\"DJ outgoing\",\"duration\":20},{\"id\":\"member-pcm-loud\",\"title\":\"DJ incoming\",\"duration\":60}]}]")
                }) }.resultCode)
                val ready = AtomicReference(false)
                await("DJ route did not start") { instrumentation.runOnMainSync { ready.set(active.isPlaying && active.mediaItemCount > 1 && active.currentMediaItem?.mediaId == "member-pcm-soft") }; ready.get() }
            }
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
                programme?.optJSONObject("primary")?.optString("id") == (if (dj) "member-pcm-soft" else "member-track") && programme.optString("transport") == "playing"
            }
            if (dj) {
                await("DJ overlap metadata missing") {
                    val programme = publicRoom().optJSONObject("program")
                    val transition = programme?.optJSONObject("transition")
                    val secondary = programme?.optJSONObject("secondary")
                    transition?.optString("phase") == "crossfading" && transition.optDouble("progress") in 0.01..0.99 && secondary != null && secondary.optString("id") != programme.optJSONObject("primary")?.optString("id")
                }
                assertTrue("DJ overlap lost decoded relay PCM", rms.get() > 500)
            }
            if (!dj) {
            await("Private thumbnail was not published for the room") {
                publicRoom().optJSONObject("program")?.optJSONObject("primary")?.optString("artwork_url")?.startsWith("https://10.0.2.2:58443/v1/artwork/$sessionId/") == true
            }
            val publicArt = publicRoom().getJSONObject("program").getJSONObject("primary").getString("artwork_url")
            LiveArtwork("https://10.0.2.2:58443", sessionId!!).use { art ->
                val bytes = art.download(publicArt)
                assertNotNull("Public thumbnail is not decodable", android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                assertTrue("Foreign artwork origin accepted", runCatching { art.download("https://127.0.0.1:58443/v1/artwork/$sessionId/foreign.jpg") }.isFailure)
                assertTrue("Another room artwork accepted", runCatching { art.download("https://10.0.2.2:58443/v1/artwork/foreign/thumbnail.jpg") }.isFailure)
            }
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
            if (!dj) {
                receiver?.close(); receiver = null
                publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/__fixture/relay-kick").header("X-Android-Fixture", "isolated")
                    .post(JSONObject().put("session_id", sessionId).put("role", "publish").toString().toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                fun hostConnected(): Boolean {
                    val observed = AtomicReference<String>()
                    instrumentation.runOnMainSync { observed.set(active.sessionExtras.getString("nativeLiveHost")) }
                    return observed.get()?.let { JSONObject(it).optBoolean("connected") } == true
                }
                await("Publisher relay cut was not observed") { !hostConnected() }
                await("Automatic publisher recovery failed") { hostConnected() }
                receiver = LivePeer(context, connection, room.getString("whep_url"), null, false, {}, sink)
                receiver!!.start(); rms.set(0.0)
                await("Recovered publisher has no relay PCM") { rms.get() > 500 }
                assertEquals("Recovery changed room identity", sessionId, publicRoom().getString("id"))
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
            if (!dj) {
                publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/__fixture/socket-cut").header("X-Android-Fixture", "isolated")
                    .post(JSONObject().put("session_id", sessionId).put("role", "host").toString().toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                await("Lost host lease kept publisher alive") {
                    val observed = AtomicReference<String>()
                    instrumentation.runOnMainSync { observed.set(active.sessionExtras.getString("nativeLiveHost")) }
                    observed.get()?.let { JSONObject(it).isNull("session") } == true
                }
                await("Disconnected host room did not expire") {
                    publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/v1/sessions/$sessionId").build()).execute().use { it.code == 404 }
                }
            }
            val stop = call { active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveStop"); putLong("generation", epoch)
            }) }
            assertEquals(androidx.media3.session.SessionResult.RESULT_SUCCESS, stop.resultCode)
            started = false
            publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/v1/sessions/$sessionId").build()).execute().use { assertEquals(404, it.code) }
            val stillPlaying = AtomicReference(false)
            instrumentation.runOnMainSync { stillPlaying.set(active.isPlaying && ProgramQueue.key(active, active.currentMediaItemIndex) == programmeKey.get()) }
            if (!dj) assertTrue("Ending Live stopped local programme", stillPlaying.get())
            else assertTrue("Ending Live stopped DJ programme", NativeProgramOutput.playing)
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
