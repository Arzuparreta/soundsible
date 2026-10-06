package com.soundsible.android

import android.content.ComponentName
import android.media.browse.MediaBrowser as LegacyBrowser
import android.media.session.MediaController as LegacyController
import android.media.MediaMetadata as LegacyMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.media3.session.SessionResult
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Car protocols observe/control the existing DJ programme, without replacing its route. */
@UnstableApi
class CarDjTest {
    @Test fun httpCarDjControlAndMetadata() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsCarDjControlAndMetadata() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val web = StartupTest()
        var modern: MediaBrowser? = null
        var legacy: LegacyBrowser? = null
        fun <T> call(work: () -> ListenableFuture<T>): T {
            val future = AtomicReference<ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }
            return future.get().get(20, TimeUnit.SECONDS)
        }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
                    while (System.nanoTime() < until) {
                        if (web.evaluate(scenario, condition) == "true") return
                        Thread.sleep(100)
                    }
                    fail("$condition: " + web.evaluate(scenario, "JSON.stringify(window.__carDj)"))
                }
                fun command(fields: String) {
                    web.evaluate(scenario, "window.__carDone=false;window.__carFailure=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,$fields})).then(()=>window.__carDone=true).catch(e=>window.__carFailure=e.code)")
                    waitFor("window.__carDone || !!window.__carFailure")
                    assertEquals("Native command failed", "true", web.evaluate(scenario, "window.__carDone===true"))
                }
                web.awaitReady(scenario)
                web.evaluate(scenario, "localStorage.setItem('lang','en')")
                scenario.recreate(); web.awaitReady(scenario)
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')")
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                    .post("{\"album\":true,\"firstFrequency\":440,\"firstDuration\":20,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody("application/json".toMediaType())).build())
                    .execute().use { assertEquals(200, it.code) }
                web.evaluate(scenario, "window.__carDjTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__carDj=s),100)")
                waitFor("window.__carDj?.ready")
                command("action:'mixing',enabled:true")
                waitFor("window.__carDj.mixing?.settingsPhase==='ready' && window.__carDj.mixing.enabled")
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20}]")
                waitFor("window.__carDj.playing")
                val active = call { MediaBrowser.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
                modern = active
                val connected = CompletableFuture<Boolean>()
                instrumentation.runOnMainSync {
                    legacy = LegacyBrowser(context, ComponentName(context, PlaybackService::class.java), object : LegacyBrowser.ConnectionCallback() {
                        override fun onConnected() { connected.complete(true) }
                        override fun onConnectionFailed() { connected.complete(false) }
                    }, null)
                    legacy!!.connect()
                }
                assertTrue(connected.get(20, TimeUnit.SECONDS))
                val controls = AtomicReference<LegacyController>()
                instrumentation.runOnMainSync { controls.set(LegacyController(context, legacy!!.sessionToken)) }
                val pcm = AtomicBoolean()
                NativeProgramOutput.subscribe(connection.generation) { block ->
                    if (block.sampleRate == 48000 && block.channels == 2 && block.bytes.any { it != 0.toByte() }) pcm.set(true)
                }.use { capture ->
                    command("action:'dj',profile:'adaptive',fromCurrent:true,key:window.__carDj.items[window.__carDj.index].key,sources:[{id:'pcm',label:'PCM',activation:0,tracks:[{id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20},{id:'member-pcm-loud',title:'DJ incoming',artist:'member artist',duration:60}]}]")
                    waitFor("window.__carDj.dj?.active && window.__carDj.playing && window.__carDj.items.length>1")
                    web.evaluate(scenario, "window.__carProgram=window.__carDj.programToken;window.__carKeys=window.__carDj.items.map(i=>i.key).join(',')")
                    assertEquals(SessionResult.RESULT_SUCCESS, call { active.getLibraryRoot(null) }.resultCode)
                    assertEquals(SessionResult.RESULT_SUCCESS, call { active.getChildren("all-tracks", 0, 200, null) }.resultCode)
                    assertEquals("Browse replaced DJ route", "true", web.evaluate(scenario, "window.__carDj.dj.active && window.__carDj.programToken===window.__carProgram && window.__carDj.items.map(i=>i.key).join(',')===window.__carKeys"))
                    waitFor("window.__carDj.id==='member-pcm-loud' && window.__carDj.index===1 && window.__carDj.playing")
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (controls.get().metadata?.getString(LegacyMetadata.METADATA_KEY_MEDIA_ID) != "member-pcm-loud" && System.nanoTime() < until) Thread.sleep(100)
                    assertEquals("member-pcm-loud", controls.get().metadata?.getString(LegacyMetadata.METADATA_KEY_MEDIA_ID))
                    instrumentation.runOnMainSync {
                        assertEquals("member-pcm-loud", active.currentMediaItem?.mediaId)
                        controls.get().transportControls.pause()
                    }
                    waitFor("!window.__carDj.playWhenReady")
                    web.evaluate(scenario, "window.__carKey=window.__carDj.items[window.__carDj.index].key")
                    instrumentation.runOnMainSync { controls.get().transportControls.seekTo(6000) }
                    waitFor("Math.abs(window.__carDj.positionMs-6000)<150 && !window.__carDj.playWhenReady")
                    pcm.set(false)
                    instrumentation.runOnMainSync { active.play() }
                    waitFor("window.__carDj.playing && window.__carDj.dj.active && window.__carDj.programToken===window.__carProgram && window.__carDj.items[window.__carDj.index].key===window.__carKey")
                    val resumed = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (!pcm.get() && System.nanoTime() < resumed) Thread.sleep(50)
                    assertTrue("Car resume did not render DJ PCM", pcm.get())
                    assertFalse(capture.failed.get())
                    instrumentation.runOnMainSync { active.pause() }
                    waitFor("!window.__carDj.playWhenReady")
                    instrumentation.runOnMainSync { controls.get().transportControls.play() }
                    waitFor("window.__carDj.playing && window.__carDj.dj.active && window.__carDj.programToken===window.__carProgram")
                    command("action:'stop'")
                    waitFor("window.__carDj.items.length===0")
                }
                web.evaluate(scenario, "clearInterval(window.__carDjTimer)")
            }
        } finally {
            modern?.let { selected -> instrumentation.runOnMainSync { selected.release() } }
            instrumentation.runOnMainSync { legacy?.disconnect() }
            connection.clearSession(true)
        }
    }
}
