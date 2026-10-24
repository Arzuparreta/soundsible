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
import java.util.concurrent.TimeUnit

/** Real HTTP/service/decoders: two pending responses must not settle a seam. */
@UnstableApi
class DjRefinementTest {
    @Test fun httpPendingAnalysisRetriesBeforeCommit() {
        val origin = InstrumentationRegistry.getArguments().getString("fixtureOrigin")
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
                fail("Refinement condition failed: $condition")
            }
            fun fixture(path: String, body: String? = null): JSONObject {
                val request = okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated")
                if (body != null) request.post(body.toRequestBody("application/json".toMediaType()))
                return connection.client.newCall(request.build()).execute().use {
                    assertEquals(200, it.code); JSONObject(it.body!!.string())
                }
            }
            fun command(fields: String) {
                web.evaluate(scenario, "window.__done=false;window.__failure=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,$fields})).then(()=>window.__done=true).catch(e=>window.__failure=e.code+':'+e.message)")
                waitFor("!!(window.__done || window.__failure)")
                assertEquals("Command failed", "true", web.evaluate(scenario, "window.__done===true"))
            }
            web.awaitReady(scenario)
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
            waitFor("!!document.querySelector('input[type=password]')")
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
            waitFor("!!document.querySelector('[data-testid=android-library]')")
            fixture("/__fixture/loudness-facts", "{\"album\":true,\"firstFrequency\":440,\"firstDuration\":90,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}")
            fixture("/__fixture/dj-refinement", "{\"pending\":2}")
            try {
                web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
                waitFor("window.__dj?.ready")
                command("action:'mixing',enabled:true")
                waitFor("window.__dj.mixing?.settingsPhase==='ready' && window.__dj.mixing.enabled===true")
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'Outgoing',artist:'Synthetic',duration:90}]")
                waitFor("window.__dj.playing && window.__dj.id==='member-pcm-soft'")
                command("action:'dj',fromCurrent:true,key:window.__dj.items[window.__dj.index].key,sources:[{id:'pcm',label:'PCM',activation:0,tracks:[{id:'member-pcm-soft',title:'Outgoing',artist:'Synthetic',duration:90},{id:'member-pcm-loud',title:'Incoming',artist:'Synthetic',duration:60}]}]")
                waitFor("window.__dj.dj?.active && window.__dj.items.length>1")
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                var calls = 0
                while (System.nanoTime() < deadline) {
                    calls = fixture("/__fixture/dj-refinement").getInt("calls")
                    if (calls >= 3) break
                    Thread.sleep(100)
                }
                assertEquals("Pending measurements were not retried", 3, calls)
                Thread.sleep(2500)
                assertEquals("Measured seam kept requesting analysis", 3, fixture("/__fixture/dj-refinement").getInt("calls"))
                assertEquals("true", web.evaluate(scenario, "window.__dj.playing && window.__dj.id==='member-pcm-soft'"))
            } finally {
                fixture("/__fixture/dj-refinement", "{\"active\":false}")
                runCatching { command("action:'stop'") }
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
            }
        }
    }
}
