package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Actual Solid UI -> Capacitor -> service-owned authenticated native Live host. */
class LiveUiTest {
    @Test fun httpHostUi() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsHostUi() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true)
        val web = StartupTest()
        var publisher: LivePeer? = null
        var roomId: String? = null
        val received = java.util.concurrent.atomic.AtomicReference(0.0)
        val sink = org.webrtc.AudioTrackSink { data, bits, _, _, frames, _ ->
            if (bits == 16 && frames > 0) {
                val view = data.asReadOnlyBuffer().order(java.nio.ByteOrder.LITTLE_ENDIAN)
                var square = 0.0; var count = 0
                while (view.remaining() >= 2) { val value = view.short.toDouble(); square += value * value; count++ }
                if (count > 0) received.set(kotlin.math.sqrt(square / count))
            }
        }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < deadline) {
                        if (web.evaluate(scenario, condition) == "true") return
                        Thread.sleep(100)
                    }
                    fail("Live UI condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')")
                scenario.recreate(); web.awaitReady(scenario)
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).some(b=>b.textContent==='member private song')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').click()")
                web.evaluate(scenario, "document.querySelector('[data-android-live]').click()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Go live' && !b.disabled)")
                web.evaluate(scenario, "(()=>{const field=document.querySelector('[data-native-live] input');field.value='UI native room';field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit();})()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='End session')")
                waitFor("document.querySelector('[data-native-live]').innerText.includes('On air')")
                waitFor("Array.from(document.querySelectorAll('[data-native-live] li strong')).some(e=>e.textContent==='UI native room')")
                web.evaluate(scenario, "Capacitor.Plugins.SoundsiblePlayback.liveState().then(s=>window.__liveState=s)")
                waitFor("!!window.__liveState?.host?.connected")
                assertEquals("false", web.evaluate(scenario, "JSON.stringify(window.__liveState).includes('publish_token') || JSON.stringify(window.__liveState).includes('host_token')"))
                web.evaluate(scenario, "(()=>{const field=document.querySelector('[data-native-live] input');field.value='UI updated title';field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit();})()")
                waitFor("document.querySelector('[data-native-live] h3')?.textContent==='UI updated title'")
                web.evaluate(scenario, "(()=>{const field=document.querySelector('[data-native-live] input[placeholder]');field.value='UI chat message';field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit();})()")
                waitFor("document.querySelector('[data-native-live]').innerText.includes('UI chat message')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='End session').click()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Go live' && !b.disabled)")
                val epoch = connection.generation
                val room = connection.execute("/api/community/sessions", "POST",
                    "{\"title\":\"UI listener room\"}".toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "ui-listener-room", 15000).use {
                    assertTrue(it.isSuccessful); JSONObject(it.body!!.string()).getJSONObject("session")
                }
                roomId = room.getString("id")
                var frame = 0L
                val source = org.webrtc.audio.WebRtcAudioRecord.ProgramInput { bytes, rate, channels ->
                    for (offset in bytes.indices step channels * 2) {
                        val value = (6000 * kotlin.math.sin(2 * Math.PI * 440 * frame / rate)).toInt()
                        for (channel in 0 until channels) { bytes[offset + channel * 2] = value.toByte(); bytes[offset + channel * 2 + 1] = (value shr 8).toByte() }
                        frame++
                    }
                }
                publisher = LivePeer(InstrumentationRegistry.getInstrumentation().targetContext, connection,
                    room.getString("whip_url"), room.getString("publish_token"), true, {}, inputFactory = { source })
                publisher.start()
                NativeLivePlayer.decodedObservers.add(sink)
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Refresh').click()")
                waitFor("Array.from(document.querySelectorAll('[data-native-live] li strong')).some(e=>e.textContent==='UI listener room')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] li')).find(e=>e.querySelector('strong')?.textContent==='UI listener room').querySelector('button').click()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Pause')")
                web.evaluate(scenario, "(()=>{const volume=document.querySelector('[data-native-live] input[type=range]');volume.value='0.8';volume.dispatchEvent(new Event('change',{bubbles:true}));})()")
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
                while (received.get() < 500 && System.nanoTime() < until) Thread.sleep(50)
                assertTrue("UI listener did not decode actual relay PCM", received.get() > 500)
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Pause').click()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Play')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Play').click()")
                waitFor("!!Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Pause')")
                web.evaluate(scenario, "(()=>{const field=document.querySelector('[data-native-live] input[placeholder]');field.value='UI guest message';field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit();})()")
                waitFor("document.querySelector('[data-native-live]').innerText.includes('UI guest message')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Leave room').click()")
                waitFor("!Array.from(document.querySelectorAll('[data-native-live] button')).some(b=>b.textContent==='Leave room')")
                publisher.close(); publisher = null
                connection.execute("/api/community/sessions/$roomId", "DELETE", null, emptyMap(), epoch, "ui-ended-room", 15000).use { assertTrue(it.isSuccessful) }
                roomId = null
                connection.execute("/api/android-fixture/session-expiry", "POST", "{\"fixture\":\"isolated\",\"seconds\":2}".toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "ui-live-expiry", 15000).use { assertTrue(it.isSuccessful) }
                Thread.sleep(2200)
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-native-live] button')).find(b=>b.textContent==='Go live').click()")
                waitFor("!!document.querySelector('input[type=password]') && !document.querySelector('[data-native-live]') && !document.querySelector('[data-testid=android-library]')")


            }
        } finally {
            NativeLivePlayer.decodedObservers.remove(sink); publisher?.close()
            roomId?.let { runCatching { connection.execute("/api/community/sessions/$it", "DELETE", null, emptyMap(), connection.generation, "ui-room-cleanup", 15000).close() } }
            connection.clearSession(true)
        }
    }
}
