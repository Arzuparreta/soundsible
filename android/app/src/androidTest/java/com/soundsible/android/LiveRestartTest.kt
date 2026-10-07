package com.soundsible.android

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
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

/** Host invokes two phases on one installation and force-stops the process between them. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class LiveRestartTest {
    @Test fun explicitRoomResumeAcrossProcessDeath() {
        val args = InstrumentationRegistry.getArguments()
        val phase = args.getString("livePhase")!!
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        val prefs = context.getSharedPreferences("live-restart-test", Context.MODE_PRIVATE)
        if (phase == "prepare") connection.clearSession(true)
        val epoch = connection.configure(args.getString("tlsOrigin")!!)
        fun core(path: String, method: String, body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "live-restart", 15000).use {
            check(it.isSuccessful) { "Core $path: ${it.code}" }; it.body?.string()?.takeIf(String::isNotBlank)?.let(::JSONObject) ?: JSONObject()
        }
        fun <T> call(work: () -> com.google.common.util.concurrent.ListenableFuture<T>): T {
            val future = AtomicReference<com.google.common.util.concurrent.ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }; return future.get().get(20, TimeUnit.SECONDS)
        }
        fun await(label: String, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(100) }
            fail(label)
        }
        if (phase == "prepare") core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        else {
            assertEquals("resume", phase)
            assertNotEquals("APK process was not restarted", prefs.getInt("pid", -1), android.os.Process.myPid())
            assertNotNull("Encrypted Core cookie lost across process death", connection.cookieHeader(epoch))
            assertEquals("member", core("/api/auth/state", "GET").getJSONObject("user").getString("username"))
        }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        val browser = call { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }
        var started = false
        var prepared = false
        try {
            val song = call { browser.getChildren("all-tracks", 0, 200, null) }.value!!.single { it.mediaId == "soundsible:track:member-track" }
            // Recovery is explicit: select music, then Go live; process death never auto-publishes.
            instrumentation.runOnMainSync { browser.setMediaItem(song); browser.prepare(); browser.play() }
            await("Native programme did not start") { NativeProgramOutput.playing }
            val start = call { browser.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply {
                putString("action", "liveStart"); putString("title", "Process recovery acceptance"); putLong("generation", epoch)
            }) }
            assertEquals(0, start.resultCode); started = true
            val room = JSONObject(start.extras.getString("liveSession")!!)
            val id = room.getString("id")
            val publicClient = okhttp3.OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
            fun programme(): JSONObject = publicClient.newCall(okhttp3.Request.Builder().url("https://10.0.2.2:58443/v1/sessions/$id").build()).execute().use {
                check(it.isSuccessful); JSONObject(it.body!!.string()).getJSONObject("session").optJSONObject("program") ?: JSONObject()
            }
            try {
                await("Room programme not public") { programme().optString("transport") == "playing" && programme().optJSONObject("primary")?.optString("id") == "member-track" }
                if (phase == "prepare") {
                    assertTrue(prefs.edit().putString("session", id).putInt("pid", android.os.Process.myPid()).putLong("seq", programme().getLong("seq")).commit())
                    // Keep the service, controller and Activity alive until the host kills this process.
                    retained.add(scenario); retained.add(browser); prepared = true
                } else {
                    assertEquals("Recovery replaced the public room", prefs.getString("session", null), id)
                    await("Recovered programme restarted its sequence") { programme().optLong("seq") > prefs.getLong("seq", 0) }
                    val rms = AtomicReference(0.0)
                    val sink = AudioTrackSink { bytes, bits, rate, _, frames, _ ->
                        if (bits == 16 && rate == 48000 && frames > 0) {
                            val samples = bytes.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN); var squares = 0.0; var count = 0
                            while (samples.remaining() >= 2) { val value = samples.short.toDouble(); squares += value * value; count++ }
                            if (count > 0) rms.set(kotlin.math.sqrt(squares / count))
                        }
                    }
                    LivePeer(context, connection, room.getString("whep_url"), null, false, {}, sink).use { receiver ->
                        receiver.start(); await("Recovered process does not emit relay PCM") { rms.get() > 500 }
                    }
                    assertEquals(0, call { browser.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "liveStop"); putLong("generation", epoch) }) }.resultCode)
                    started = false; prefs.edit().clear().commit()
                }
            } finally { publicClient.connectionPool.evictAll(); publicClient.dispatcher.executorService.shutdown() }
        } finally {
            if (!prepared) {
                if (started) runCatching { call { browser.sendCustomCommand(ProgramQueue.command, android.os.Bundle().apply { putString("action", "liveStop"); putLong("generation", epoch) }) } }
                instrumentation.runOnMainSync { browser.release() }; scenario.close(); connection.clearSession(true)
            }
        }
    }
    companion object { private val retained = mutableListOf<Any>() }
}
