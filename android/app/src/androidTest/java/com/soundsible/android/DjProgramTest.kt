package com.soundsible.android

import androidx.media3.common.util.UnstableApi
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
                waitFor("window.__done || window.__failure")
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
            try {
            web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
            waitFor("window.__dj?.ready")
            command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'DJ outgoing',artist:'member artist',duration:20}]")
            waitFor("window.__dj.playing && window.__dj.id==='member-pcm-soft'")
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
                command("action:'pause'")
                waitFor("!window.__dj.playWhenReady")
                Thread.sleep(300)
                web.evaluate(scenario, "window.__djPaused=window.__dj.positionMs")
                Thread.sleep(500)
                assertEquals("Programme advanced while paused", "true", web.evaluate(scenario, "Math.abs(window.__dj.positionMs-window.__djPaused)<100"))
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
                scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]') && !document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
                waitFor("window.__dj.dj?.active && window.__dj.id==='member-pcm-loud'")
                command("action:'play'"); waitFor("window.__dj.playing")
                command("action:'stop'"); waitFor("window.__dj.items.length===0")
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'NORMAL restored',artist:'member artist'}]")
                waitFor("window.__dj.playing && !window.__dj.dj?.active && window.__dj.id==='member-track'")
                command("action:'stop'")
            }
            } finally {
            try { for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), connection.generation, "dj-cleanup-$id", 15000).use { assertTrue(it.isSuccessful) }
            } finally { connection.clearSession(true) }
            }
        }
    }
}
