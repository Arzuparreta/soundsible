package com.soundsible.android

import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import android.content.ComponentName
import android.media.AudioManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.Lifecycle
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.hypot

/** Real Core/service execution with a bounded stall across Range reopens in authenticated incoming audio. */
@UnstableApi
class DjNetworkTest {
    @Test fun httpIncomingBodyStall() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsIncomingBodyStall() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true)
        val web = StartupTest()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun waitFor(condition: String) {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
                while (System.nanoTime() < deadline) {
                    if (web.evaluate(scenario, condition) == "true") return
                    Thread.sleep(100)
                }
                fail("DJ condition failed: $condition; state=" + web.evaluate(scenario, "JSON.stringify(window.__dj)"))
            }
            fun command(fields: String) {
                web.evaluate(scenario, "window.__done=false;window.__failure=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,$fields})).then(()=>window.__done=true).catch(e=>window.__failure=e.code+':'+e.message)")
                waitFor("!!(window.__done || window.__failure)")
                assertEquals("Command rejected: " + web.evaluate(scenario, "window.__failure"), "true", web.evaluate(scenario, "window.__done===true"))
            }
            web.awaitReady(scenario)
            web.evaluate(scenario, "localStorage.setItem('lang','en')")
            scenario.recreate(); web.awaitReady(scenario)
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
            waitFor("!!document.querySelector('input[type=password]')")
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
            waitFor("!!document.querySelector('[data-testid=android-library]')")
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                .post("{\"album\":true,\"firstFrequency\":440,\"firstDuration\":20,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
            var mediaController: MediaController? = null
            try {
            web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
            waitFor("window.__dj?.ready")
            command("action:'mixing',enabled:true")
            waitFor("window.__dj.mixing?.settingsPhase==='ready' && window.__dj.mixing.enabled===true")
            command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20}]")
            waitFor("window.__dj.playing && window.__dj.id==='member-pcm-soft'")
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val controllerFuture = AtomicReference<com.google.common.util.concurrent.ListenableFuture<MediaController>>()
            instrumentation.runOnMainSync {
                controllerFuture.set(MediaController.Builder(instrumentation.targetContext,
                    SessionToken(instrumentation.targetContext, ComponentName(instrumentation.targetContext, PlaybackService::class.java))).buildAsync())
            }
            val controller = controllerFuture.get().get(10, TimeUnit.SECONDS)
            mediaController = controller
            val retainedKey = web.evaluate(scenario, "window.__dj.items[0].key")
            val freshIncoming = AtomicBoolean()
            val incomingKey = AtomicReference<String>()
            val capture = NativeProgramOutput.subscribe(connection.generation) { block ->
                if (block.stream.key == incomingKey.get() && block.sampleRate == 48000 && block.channels == 2 && block.bytes.any { it != 0.toByte() }) freshIncoming.set(true)
            }
            try {
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/dj-network")
                    .post("{}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(403, it.code) }
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/dj-network").header("X-Android-Fixture", "isolated")
                    .post("{\"track\":\"member-pcm-loud\",\"afterBytes\":600000,\"delaySeconds\":22}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                command("action:'dj',profile:'adaptive',fromCurrent:true,key:window.__dj.items[window.__dj.index].key,sources:[{id:'pcm',label:'PCM',activation:0,tracks:[{id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20},{id:'member-pcm-loud',title:'DJ incoming',artist:'member artist',duration:60}]}]")
                waitFor("window.__dj.dj?.active && window.__dj.playing && window.__dj.items.length>1")
                waitFor("window.__dj.dj.editableFrom>window.__dj.index+1")
                incomingKey.set(web.evaluate(scenario, "window.__dj.items[1].key").trim('"'))
                // The body stalls after about three seconds of stereo PCM. The outgoing
                // source must retain its occurrence and advancing clock while
                // the incoming request remains incomplete.
                waitFor("window.__dj.positionMs>17000 && window.__dj.id==='member-pcm-soft'")
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/dj-network").header("X-Android-Fixture", "isolated").build()).execute().use {
                    assertEquals(200, it.code)
                    val network = JSONObject(it.body!!.string())
                    assertTrue("No fixture body actually stalled", network.getInt("waits") > 0)
                    assertTrue("Recovery was not observed during a body stall", network.getInt("pending") > 0)
                }
                assertEquals(retainedKey, web.evaluate(scenario, "window.__dj.items[window.__dj.index].key"))
                instrumentation.runOnMainSync { assertNull(controller.playerError); assertTrue(controller.playWhenReady) }
                freshIncoming.set(false)
                waitFor("window.__dj.id==='member-pcm-loud' && window.__dj.playing")
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (!freshIncoming.get() && System.nanoTime() < deadline) Thread.sleep(50)
                assertTrue("No resumed native PCM after network stall", freshIncoming.get())
                assertFalse(capture.failed.get())
                Thread.sleep(2000) // Let the restored handoff physically retire its old input.
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/audio-failure").header("X-Android-Fixture", "isolated")
                    .post("{\"status\":503}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                instrumentation.runOnMainSync { controller.seekTo(controller.currentMediaItemIndex, 0) }
                waitFor("window.__dj.errorStatus===503 && !window.__dj.playWhenReady")
                val failedKey = web.evaluate(scenario, "window.__dj.items[window.__dj.index].key")
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/audio-failure").header("X-Android-Fixture", "isolated")
                    .post("{\"status\":0}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                freshIncoming.set(false)
                instrumentation.runOnMainSync { controller.play() }
                waitFor("window.__dj.playing && window.__dj.error===0")
                assertEquals(failedKey, web.evaluate(scenario, "window.__dj.items[window.__dj.index].key"))
                val resumed = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (!freshIncoming.get() && System.nanoTime() < resumed) Thread.sleep(50)
                assertTrue("System controller retry did not resume retained PCM", freshIncoming.get())
            } finally {
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/audio-failure").header("X-Android-Fixture", "isolated")
                    .post("{\"status\":0}".toRequestBody("application/json".toMediaType())).build()).execute().close()
                capture.close()
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/dj-network").header("X-Android-Fixture", "isolated")
                    .post("{\"track\":\"member-pcm-loud\",\"delaySeconds\":0}".toRequestBody("application/json".toMediaType())).build()).execute().close()
            }
            } finally {
                InstrumentationRegistry.getInstrumentation().runOnMainSync { mediaController?.release() }
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
                val generation = connection.generation
                for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "network-cleanup-$id", 15000).close()
                connection.clearSession(true)
            }
        }
    }
}
