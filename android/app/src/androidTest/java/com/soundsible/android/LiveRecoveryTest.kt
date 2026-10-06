package com.soundsible.android

import android.media.AudioManager
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.common.Player
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real relay rejection, manual retry, system focus/noisy and account reset during TLS OPTIONS. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LiveRecoveryTest {
    @Test fun httpRecovery() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!, false)
    @Test fun tlsRecovery() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!, false)
    @Test fun httpReset() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!, true)
    @Test fun tlsReset() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!, true)
    @Test fun httpPublisherRecovery() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!, false, true)
    @Test fun tlsPublisherRecovery() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!, false, true)
    private fun run(origin: String, reset: Boolean, publisherRecovery: Boolean = false) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val epoch = connection.configure(origin)
        fun core(path: String, method: String, body: JSONObject? = null): JSONObject = connection.execute(path, method,
            (body ?: JSONObject()).toString().takeIf { method != "GET" }?.toRequestBody("application/json".toMediaType()),
            emptyMap(), connection.generation, "live-recovery-test", 15000).use {
                val text = it.body?.string().orEmpty(); check(it.isSuccessful) { "$path ${it.code}: $text" }
                if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        val client = okhttp3.OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
        fun fixture(path: String, body: JSONObject? = null): JSONObject = client.newCall(okhttp3.Request.Builder()
            .url("https://10.0.2.2:58443/__fixture/$path").header("X-Android-Fixture", "isolated")
            .apply { if (body != null) post(body.toString().toRequestBody("application/json".toMediaType())) }.build()).execute().use {
                assertEquals(200, it.code); JSONObject(it.body!!.string())
            }
        fun <T> main(work: () -> T): T {
            val result = AtomicReference<T>(); instrumentation.runOnMainSync { result.set(work()) }; return result.get()
        }
        fun await(label: String, timeout: Long = 25, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeout)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label)
        }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        val room = core("/api/community/sessions", "POST", JSONObject().put("title", "Recovery acceptance")).getJSONObject("session")
        val id = room.getString("id")
        var scenario: ActivityScenario<MainActivity>? = null
        var publisher: LivePeer? = null
        var player: NativeLivePlayer? = null
        var host: NativeCommunitySocket? = null
        var browser: androidx.media3.session.MediaBrowser? = null
        val audio = context.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        val competing = android.media.AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).build())
            .setOnAudioFocusChangeListener { }.build()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            if (publisherRecovery) {
                val active = main { androidx.media3.session.MediaBrowser.Builder(context, androidx.media3.session.SessionToken(context,
                    android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
                browser = active
                fun command(action: String): androidx.media3.session.SessionResult = main {
                    active.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                        putString("action", action); putLong("generation", connection.generation); putString("title", "Publisher recovery")
                    })
                }.get(15, TimeUnit.SECONDS)
                fun snapshot(): JSONObject? = main { active.sessionExtras.getString("nativeLiveHost") }?.let(::JSONObject)
                val songs = main { active.getChildren("all-tracks", 0, 200, null) }.get(15, TimeUnit.SECONDS).value!!
                main { active.setMediaItem(songs.single { it.mediaId == "soundsible:track:member-track" }); active.prepare(); active.play() }
                await("Local programme not playing") { NativeProgramOutput.playing }
                assertEquals(0, command("liveStart").resultCode)
                await("Publisher did not connect") { snapshot()?.optBoolean("connected") == true }
                val key = main { ProgramQueue.key(active, active.currentMediaItemIndex) }
                scenario.close(); scenario = null
                fun block() = fixture("read-failure", JSONObject().put("session_id", id).put("role", "publish").put("blocked", true))
                fun denied() = fixture("read-failure?session_id=$id&role=publish").getInt("denied")
                fun kick() = fixture("relay-kick", JSONObject().put("session_id", id).put("role", "publish"))
                block(); kick()
                await("Publisher retry exhaustion did not retire Live", 40) { snapshot()?.isNull("session") == true }
                assertEquals("Publisher must perform exactly three reconnect attempts", 3, denied())
                Thread.sleep(2000); assertEquals(3, denied())
                assertTrue("Live exhaustion stopped local music", NativeProgramOutput.playing)
                assertEquals("Live exhaustion replaced local queue occurrence", key, main { ProgramQueue.key(active, active.currentMediaItemIndex) })
                fixture("read-failure", JSONObject().put("session_id", id).put("role", "publish").put("blocked", false))
                assertEquals(0, command("liveStart").resultCode)
                await("Explicit publisher recovery did not preserve room") { snapshot()?.let { it.optBoolean("connected") && it.optJSONObject("session")?.optString("id") == id } == true }
                block(); kick()
                await("Publisher reconnect rejection not reached") { denied() >= 1 }
                main { connection.clearSession(false) }
                await("Account reset did not retire publisher", 3) { snapshot()?.isNull("session") == true }
                val stopped = denied(); Thread.sleep(5000)
                assertEquals("Stale publisher continued retrying after account reset", stopped, denied())
                assertEquals(0, fixture("relay-state?session_id=$id").getInt("publishers"))
                core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
                return
            }
            host = NativeCommunitySocket(room.getString("socket_url"), mapOf("session_id" to id, "host_token" to room.getString("host_token")),
                android.os.Handler(android.os.Looper.getMainLooper()), { connection.generation == epoch }, { _, _ -> })
            host.connect(); host.awaitConnected()
            if (reset) {
                val count = fixture("read-failure?session_id=$id").getInt("slow_listeners")
                val slow = JSONObject(room.toString()).put("whep_url", "https://10.0.2.2:58443/__fixture/slow-listener")
                val active = main { NativeLivePlayer(context, connection, slow).also { it.prepare(); it.play() } }; player = active
                await("Slow listener OPTIONS not reached") { fixture("read-failure?session_id=$id").getInt("slow_listeners") == count + 1 }
                val start = System.nanoTime()
                main { connection.clearSession(false) }
                await("Reset did not retire Live", 3) { main { active.playbackState == Player.STATE_IDLE && !active.playWhenReady } }
                assertTrue(System.nanoTime() - start < TimeUnit.SECONDS.toNanos(3))
                Thread.sleep(8000)
                assertEquals("Stale listener retried after reset", count + 1, fixture("read-failure?session_id=$id").getInt("slow_listeners"))
                assertEquals(0, fixture("relay-state?session_id=$id").getInt("readers"))
                main { active.prepare(); active.play(); assertEquals(Player.STATE_IDLE, active.playbackState); assertFalse(active.playWhenReady) }
                // Restore only test credentials for signed cleanup; the stale player keeps its old generation.
                core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
            } else {
                var frame = 0L
                val input = org.webrtc.audio.WebRtcAudioRecord.ProgramInput { bytes, rate, channels ->
                    for (offset in bytes.indices step channels * 2) {
                        val value = (6000 * kotlin.math.sin(2 * Math.PI * 440 * frame++ / rate)).toInt()
                        for (channel in 0 until channels) { bytes[offset + channel * 2] = value.toByte(); bytes[offset + channel * 2 + 1] = (value shr 8).toByte() }
                    }
                }
                publisher = LivePeer(context, connection, room.getString("whip_url"), room.getString("publish_token"), true, {}, inputFactory = { input })
                publisher.start()
                fixture("read-failure", JSONObject().put("session_id", id).put("blocked", true))
                val active = main { NativeLivePlayer(context, connection, room).also { it.volume = .4f; it.prepare(); it.play() } }; player = active
                await("Persistent relay rejection did not exhaust retries", 40) { main { active.playerError != null && active.playbackState == Player.STATE_IDLE && !active.playWhenReady } }
                val denied = fixture("read-failure?session_id=$id").getInt("denied")
                assertEquals("Retry budget must be initial attempt plus three retries", 4, denied)
                Thread.sleep(2000)
                assertEquals("Retries continued after exhaustion", denied, fixture("read-failure?session_id=$id").getInt("denied"))
                fixture("read-failure", JSONObject().put("session_id", id).put("blocked", false))
                main { active.prepare(); active.play() }
                await("Manual retry failed") { main { active.isPlaying && active.playerError == null && active.volume == .4f } }
                main { assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED, audio.requestAudioFocus(competing)) }
                await("System focus did not suppress Live") { main { !active.isPlaying && active.playWhenReady && active.playbackSuppressionReason == Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS } }
                main { audio.abandonAudioFocusRequest(competing) }
                await("System focus gain did not resume Live") { main { active.isPlaying } }
                instrumentation.uiAutomation.executeShellCommand("su 1000 am broadcast -a android.media.AUDIO_BECOMING_NOISY -p ${context.packageName}").use { descriptor ->
                    java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
                }
                await("Noisy output did not pause Live") { main { !active.playWhenReady } }
                assertEquals(1, fixture("relay-state?session_id=$id").getInt("readers"))
                main { active.play() }
                await("Manual resume after noisy failed") { main { active.isPlaying } }
            }
        } finally {
            main { audio.abandonAudioFocusRequest(competing); player?.release() }
            publisher?.close(); host?.close(); main { browser?.release() }; scenario?.close()
            runCatching { connection.execute("/api/community/sessions/$id", "DELETE", null, emptyMap(), connection.generation, "live-recovery-cleanup", 15000).close() }
            connection.clearSession(true); client.dispatcher.cancelAll(); client.connectionPool.evictAll()
        }
    }
}
