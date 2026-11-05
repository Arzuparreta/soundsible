package com.soundsible.android

import androidx.media3.common.util.UnstableApi
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * Both decks meet at a shared tempo on the native output, measured on its PCM.
 *
 * The fixture turns the PCM album into click tracks at 120 and 132 BPM with
 * different pitches and serves the plan the engine sends this client
 * (scripts/android_dj_fixture.py). The real service ramps the outgoing deck,
 * plays the incoming one at the relation times that speed and mixes them; the
 * recorded output says where each kick actually sounded.
 */
@UnstableApi
class DjSharedTempoTest {
    @Test fun bothDecksMeetAtASharedTempoAndTheirKicksSoundTogether() = run(true)
    /** The same measurement with the incoming deck alone moving (120 → 126 BPM), as before shared tempo. */
    @Test fun incomingDeckAloneKeepsItsKicksOnTheOutgoingOnes() = run(false)
    private fun run(split: Boolean) {
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")
        assumeNotNull(origin)
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true)
        val web = StartupTest()
        fun fixture(path: String, body: String?): JSONObject {
            val request = okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated")
            if (body != null) request.post(body.toRequestBody("application/json".toMediaType()))
            return connection.client.newCall(request.build()).execute().use {
                assertEquals(200, it.code); JSONObject(it.body!!.string())
            }
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            fun waitFor(condition: String, seconds: Long = 45) {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
                while (System.nanoTime() < deadline) {
                    if (web.evaluate(scenario, condition) == "true") return
                    Thread.sleep(100)
                }
                fail("DJ condition failed: $condition; fixture=" + runCatching { fixture("/__fixture/dj-shared-tempo", null).optJSONArray("plans") }.getOrNull() +
                    "; state=" + web.evaluate(scenario, "JSON.stringify(window.__dj)"))
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
            fixture("/__fixture/loudness-facts", "{\"album\":true,\"firstFrequency\":440,\"firstDuration\":90,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}")
            val setup = fixture("/__fixture/dj-shared-tempo", "{\"active\":true,\"split\":$split}")
            val plan = setup.getJSONObject("plan")
            val tones = setup.getJSONObject("tones")
            try {
                web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
                waitFor("window.__dj?.ready")
                command("action:'mixing',enabled:true")
                waitFor("window.__dj.mixing?.settingsPhase==='ready' && window.__dj.mixing.enabled===true")
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'Clicks 120',artist:'member artist',duration:90}]")
                waitFor("window.__dj.playing && window.__dj.id==='member-pcm-soft'")
                // The whole programme output, in order, with its output frame.
                val blocks = java.util.concurrent.ConcurrentLinkedQueue<Pair<Long, ShortArray>>()
                var sampleRate = 0
                NativeProgramOutput.subscribe(connection.generation) { block ->
                    val input = ByteBuffer.wrap(block.bytes).order(ByteOrder.LITTLE_ENDIAN)
                    val count = input.remaining() / (block.channels * 2)
                    sampleRate = block.sampleRate
                    val mono = ShortArray(count) { val value = input.short; repeat(block.channels - 1) { input.short }; value }
                    blocks.add(block.frameOffset to mono)
                }.use { capture ->
                    command("action:'dj',fromCurrent:true,key:window.__dj.items[window.__dj.index].key,sources:[{id:'clicks',label:'Clicks',activation:0,tracks:[{id:'member-pcm-soft',title:'Clicks 120',artist:'member artist',duration:90},{id:'member-pcm-loud',title:'Clicks 132',artist:'member artist',duration:60}]}]")
                    waitFor("window.__dj.dj?.active && window.__dj.playing && window.__dj.items.length>1")
                    waitFor("window.__dj.id==='member-pcm-loud' && window.__dj.playing", 90)
                    Thread.sleep(3000)
                    assertFalse("Native capture failed", capture.failed.get())
                    assertEquals("Native capture dropped blocks", 0L, capture.dropped.get())
                }
                val state = fixture("/__fixture/dj-shared-tempo", null)
                assertTrue("The native planner did not ask for shared-tempo plans", state.getInt("split_requests") > 0)
                assertEquals(0, state.getInt("other_requests"))

                val ordered = blocks.sortedBy { it.first }
                val start = ordered.first().first
                val pcm = ShortArray((ordered.last().first - start).toInt() + ordered.last().second.size)
                for ((frame, samples) in ordered) samples.copyInto(pcm, (frame - start).toInt())
                fun onsets(tone: Int): List<Double> {
                    val step = sampleRate / 2000; val window = sampleRate / 500
                    val envelope = DoubleArray((pcm.size - window) / step) { index ->
                        var re = 0.0; var im = 0.0
                        for (i in index * step until index * step + window) {
                            val phase = 2 * Math.PI * tone * i / sampleRate
                            re += pcm[i] * cos(phase); im -= pcm[i] * sin(phase)
                        }
                        hypot(re, im) / window
                    }
                    val peak = envelope.max()
                    val times = mutableListOf<Double>(); var quietUntil = 0.0
                    envelope.forEachIndexed { index, value ->
                        val time = (index * step + window / 2.0) / sampleRate
                        if (value > peak * 0.08 && time >= quietUntil) { times.add(time); quietUntil = time + 0.15 }
                    }
                    return times
                }
                val out = onsets(tones.getInt("out_tone"))
                val incoming = onsets(tones.getInt("in_tone"))
                fun intervals(times: List<Double>) = times.zipWithNext { a, b -> b - a }
                fun median(values: List<Double>) = values.sorted()[values.size / 2]
                val outBeat = 60.0 / tones.getInt("out_bpm")
                val outRate = plan.getDouble("out_playback_rate")
                assertEquals(split, outRate != 1.0)
                val shared = outBeat / outRate
                // Before its ramp the outgoing deck keeps its own tempo...
                assertEquals(outBeat, median(intervals(out.take(10))), 0.003)
                // ...and through the blend both decks play the shared one.
                // Only kicks where both decks sound: the incoming deck goes on
                // alone after the blend, and the faded outgoing one drops
                // below the detector first. The middle of that span.
                val both = incoming.filter { it <= out.last() + shared / 2 }
                val blend = both.subList((both.size * 0.2).toInt(), (both.size * 0.8).toInt().coerceAtLeast(1))
                assertTrue("Too few incoming kicks during the blend: ${both.size}", blend.size >= 6)
                val outDuring = out.filter { it > blend.first() - 1 && it < blend.last() + 0.2 }
                assertEquals(shared, median(intervals(blend)), 0.003)
                assertEquals(shared, median(intervals(outDuring)), 0.003)
                val signed = blend.map { time -> out.minBy { abs(it - time) }.let { time - it } }
                val meanAbs = signed.sumOf { abs(it) } / signed.size
                val report = (if (split) "shared tempo: " else "incoming deck alone: ") + "beat %.4f s, mean |error| %.1f ms, signed (ms) %s".format(shared, meanAbs * 1000,
                    signed.joinToString(" ") { "%.1f".format(it * 1000) })
                android.util.Log.i("DjSharedTempoTest", report)
                assertTrue(report, meanAbs < 0.03)
            } finally {
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
                runCatching { command("action:'stop'") }
                fixture("/__fixture/dj-shared-tempo", "{\"active\":false}")
            }
        }
    }
}
