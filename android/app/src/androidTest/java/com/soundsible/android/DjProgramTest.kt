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

/** Real Core plan, bridge, service, PCM output and Activity lifecycle in one flow. */
@UnstableApi
class DjProgramTest {
    @Test fun httpDjFromCurrent() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsDjFromCurrent() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
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
            val key = web.evaluate(scenario, "window.__dj.items[0].key")
            val mixed = AtomicBoolean()
            NativeProgramOutput.subscribe(connection.generation) { block ->
                val input = ByteBuffer.wrap(block.bytes).order(ByteOrder.LITTLE_ENDIAN)
                val count = input.remaining() / (block.channels * 2)
                if (count < block.sampleRate / 100) return@subscribe
                val real = DoubleArray(2); val imaginary = DoubleArray(2)
                repeat(count) { frame ->
                    val value = input.short.toDouble(); repeat(block.channels - 1) { input.short }
                    for ((index, frequency) in intArrayOf(440, 880).withIndex()) {
                        val phase = 2 * Math.PI * frequency * frame / block.sampleRate
                        real[index] += value * cos(phase); imaginary[index] -= value * sin(phase)
                    }
                }
                val outgoing = hypot(real[0], imaginary[0]) * 2 / count
                val incoming = hypot(real[1], imaginary[1]) * 2 / count
                if (block.sampleRate == 48000 && block.channels == 2 && outgoing > 1000 && incoming > 2500) mixed.set(true)
            }.use { capture ->
                command("action:'dj',profile:'adaptive',fromCurrent:true,key:window.__dj.items[window.__dj.index].key,sources:[{id:'pcm',label:'PCM',activation:0,tracks:[{id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20},{id:'member-pcm-loud',title:'DJ incoming',artist:'member artist',duration:60}]}]")
                waitFor("window.__dj.dj?.active && window.__dj.playing && window.__dj.items.length>1")
                assertEquals(key, web.evaluate(scenario, "window.__dj.items[0].key"))
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"))
                scenario.moveToState(Lifecycle.State.CREATED)
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (!mixed.get() && System.nanoTime() < deadline) Thread.sleep(100)
                assertTrue("Service did not render both tones while Activity was stopped", mixed.get())
                assertFalse("Native capture failed", capture.failed.get())
                scenario.moveToState(Lifecycle.State.RESUMED)
                waitFor("window.__dj.id==='member-pcm-loud' && window.__dj.index===1 && window.__dj.playing")
                instrumentation.runOnMainSync {
                    assertEquals("member-pcm-loud", controller.currentMediaItem?.mediaId)
                    assertEquals(1, controller.currentMediaItemIndex)
                    controller.pause()
                }
                waitFor("!window.__dj.playWhenReady")
                command("action:'mixing',enabled:false")
                waitFor("window.__dj.mixing?.settingsPhase==='ready' && window.__dj.mixing.enabled===false")
                Thread.sleep(300)
                web.evaluate(scenario, "window.__djPaused=window.__dj.positionMs")
                Thread.sleep(500)
                assertEquals("Programme advanced while paused", "true", web.evaluate(scenario, "Math.abs(window.__dj.positionMs-window.__djPaused)<100"))
                web.evaluate(scenario, "window.__retainedKey=window.__dj.items[window.__dj.index].key;window.__retainedProgram=window.__dj.programToken")
                command("action:'append',tracks:[{source:'local',id:'member-track',title:'Added future',artist:'member artist'},{source:'local',id:'member-track',title:'Second occurrence',artist:'member artist'}]")
                waitFor("window.__dj.items.length===4")
                command("action:'move',index:3,toIndex:2,key:window.__dj.items[3].key")
                waitFor("window.__dj.items[2].title==='Second occurrence'")
                command("action:'remove',index:3,key:window.__dj.items[3].key")
                waitFor("window.__dj.items.length===3")
                assertEquals("Route edit replaced the playing occurrence", "true", web.evaluate(scenario, "window.__dj.items[window.__dj.index].key===window.__retainedKey && window.__dj.programToken===window.__retainedProgram && !window.__dj.playWhenReady && Math.abs(window.__dj.positionMs-window.__djPaused)<100"))
                command("action:'djSettings',profile:'long_blend',direction:{energy:0,familiarity:0,prompt:'',include:[],exclude:[]}")
                waitFor("window.__dj.dj?.profile==='long_blend' && !['planning','warming'].includes(window.__dj.dj.phase)")
                assertEquals("Settings changed paused playback", "true", web.evaluate(scenario, "window.__dj.items[window.__dj.index].key===window.__retainedKey && !window.__dj.playWhenReady && Math.abs(window.__dj.positionMs-window.__djPaused)<100"))
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
                scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]') && !document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
                waitFor("window.__dj.dj?.active && window.__dj.id==='member-pcm-loud'")
                instrumentation.runOnMainSync { controller.play() }; waitFor("window.__dj.playing")
                val audioManager = instrumentation.targetContext.getSystemService(AudioManager::class.java)
                val competingFocus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                    .setOnAudioFocusChangeListener { }.build()
                try {
                    instrumentation.runOnMainSync { assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED, audioManager.requestAudioFocus(competingFocus)) }
                    waitFor("window.__dj.playWhenReady && !window.__dj.playing")
                    Thread.sleep(300)
                    web.evaluate(scenario, "window.__focusPosition=window.__dj.positionMs")
                    Thread.sleep(500)
                    assertEquals("Transient focus advanced DJ", "true", web.evaluate(scenario, "Math.abs(window.__dj.positionMs-window.__focusPosition)<100"))
                } finally { instrumentation.runOnMainSync { audioManager.abandonAudioFocusRequest(competingFocus) } }
                waitFor("window.__dj.playing")
                // Private receiver accepts real system events, never an ordinary app or shell sender.
                instrumentation.uiAutomation.executeShellCommand("su 1000 am broadcast -a android.media.AUDIO_BECOMING_NOISY -p ${instrumentation.targetContext.packageName}").use { descriptor ->
                    android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
                }
                waitFor("!window.__dj.playWhenReady && !window.__dj.playing")
                instrumentation.runOnMainSync { controller.play() }; waitFor("window.__dj.playing")
                command("action:'stop'"); waitFor("window.__dj.items.length===0")
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'NORMAL restored',artist:'member artist'}]")
                waitFor("window.__dj.playing && !window.__dj.dj?.active && window.__dj.id==='member-track'")
                instrumentation.runOnMainSync { assertEquals("member-track", controller.currentMediaItem?.mediaId) }
                command("action:'stop'")
                waitFor("window.__dj.items.length===0 && !window.__dj.dj?.active")
                command("action:'dj',profile:'open_format',fromCurrent:false,sources:[{id:'pcm-only',label:'PCM collection',activation:0,tracks:[{id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20},{id:'member-pcm-loud',title:'DJ incoming',artist:'member artist',duration:60}]}]")
                waitFor("window.__dj.dj?.active && window.__dj.playing && window.__dj.items.length>=2")
                assertEquals("true", web.evaluate(scenario, "window.__dj.dj.profile==='open_format' && window.__dj.dj.sources[0].id==='pcm-only' && window.__dj.programToken!==window.__retainedProgram"))
                web.evaluate(scenario, "window.__offFirst=window.__dj.id;window.__offDuration=window.__dj.durationMs")
                command("action:'seek',positionMs:Math.max(0,window.__offDuration-6000)")
                waitFor("window.__dj.playing && window.__dj.positionMs>=window.__offDuration-6000")
                Thread.sleep(300); mixed.set(false)
                Thread.sleep(4000)
                assertEquals("Disabled mixing changed the opening prematurely", "true", web.evaluate(scenario, "window.__dj.id===window.__offFirst && window.__dj.positionMs>=window.__offDuration-2500"))
                waitFor("window.__dj.id!==window.__offFirst && window.__dj.playing")
                assertFalse("Disabled mixing rendered an overlap", mixed.get())
                command("action:'stop'")
                command("action:'mixing',enabled:true")
                waitFor("window.__dj.mixing?.settingsPhase==='ready' && window.__dj.mixing.enabled===true")
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/radio-seed").header("X-Android-Fixture", "isolated")
                    .post("{}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                command("action:'dj',profile:'adaptive',fromCurrent:false,sources:[{id:'refill',label:'Refill collection',activation:0,tracks:Array.from({length:10},(_,i)=>({id:'member-radio-'+i,title:'Radio '+i,artist:'member artist',duration:600}))}]")
                waitFor("window.__dj.dj?.active && window.__dj.playing && window.__dj.items.length>=8")
                web.evaluate(scenario, "window.__beforeRefill=window.__dj.items.length")
                command("action:'select',index:window.__dj.items.length-3,key:window.__dj.items[window.__dj.items.length-3].key")
                waitFor("window.__dj.items.length>window.__beforeRefill")
                command("action:'pause'"); waitFor("!window.__dj.playWhenReady")
                Thread.sleep(300)
                web.evaluate(scenario, "window.__refillKey=window.__dj.items[window.__dj.index].key;window.__refillPosition=window.__dj.positionMs")
                command("action:'djSettings',sources:[{id:'new-pcm',label:'New source',activation:0,tracks:[{id:'member-pcm-soft',title:'New soft',artist:'member artist',duration:20},{id:'member-pcm-loud',title:'New loud',artist:'member artist',duration:60}]}]")
                waitFor("window.__dj.dj?.sources[0].id==='new-pcm' && window.__dj.items.slice(window.__dj.index+1).some(item=>item.id==='member-pcm-soft')")
                assertEquals("Replan replaced or resumed the current input", "true", web.evaluate(scenario, "window.__dj.items[window.__dj.index].key===window.__refillKey && !window.__dj.playWhenReady && Math.abs(window.__dj.positionMs-window.__refillPosition)<100"))
                command("action:'radio',enabled:true,profile:'balanced'")
                waitFor("!window.__dj.dj?.active && window.__dj.radio?.active && !window.__dj.playWhenReady")
                assertEquals("Radio discarded the retained occurrence or resumed paused playback", "true", web.evaluate(scenario, "window.__dj.items[window.__dj.index].key===window.__refillKey && Math.abs(window.__dj.positionMs-window.__refillPosition)<150"))
                instrumentation.runOnMainSync { controller.play() }
                waitFor("window.__dj.playing && !window.__dj.dj?.active && window.__dj.radio?.active")
                command("action:'stop'")
            }
            } finally {
            mediaController?.let { controller -> InstrumentationRegistry.getInstrumentation().runOnMainSync { controller.release() } }
            try { for (id in listOf("member-pcm-soft", "member-pcm-loud") + (0 until 10).map { "member-radio-$it" }) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), connection.generation, "dj-cleanup-$id", 15000).use { assertTrue(it.isSuccessful || it.code == 404) }
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                .post("{\"measured\":false}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
            } finally { connection.clearSession(true) }
            }
        }
    }
}
