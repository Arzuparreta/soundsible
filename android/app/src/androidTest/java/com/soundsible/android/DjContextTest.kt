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

/** Real library menus change DJ context while preserving paused playback and listener requests. */
@UnstableApi
class DjContextTest {
    @Test fun httpSongContext() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsSongContext() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
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
            try {
                web.evaluate(scenario, "window.__djTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__dj=s),100)")
                waitFor("window.__dj?.ready")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh').click()")
                waitFor("Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).some(b=>b.textContent==='member louder PCM song')")
                fun menu(title: String, action: String) {
                    web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent===" + JSONObject.quote(title) + ").closest('[data-music-list-row]').querySelector('[data-row-menu]').click()")
                    waitFor("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(action) + ")")
                    web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(action) + ").click()")
                }
                command("action:'queue',index:0,tracks:[{source:'local',id:'member-pcm-soft',title:'member softer PCM song',artist:'member artist',duration:20}]")
                waitFor("window.__dj.playing")
                command("action:'pause'")
                waitFor("!window.__dj.playWhenReady")
                val key = web.evaluate(scenario, "window.__dj.items[window.__dj.index].key")
                val position = web.evaluate(scenario, "window.__dj.positionMs").toDouble()
                fun retained() {
                    assertEquals(key, web.evaluate(scenario, "window.__dj.items[window.__dj.index].key"))
                    assertEquals("false", web.evaluate(scenario, "window.__dj.playWhenReady"))
                    assertEquals(position, web.evaluate(scenario, "window.__dj.positionMs").toDouble(), 150.0)
                }
                menu("member louder PCM song", "Start DJ from this song")
                waitFor("window.__dj.dj?.active && window.__dj.items[1]?.id==='member-pcm-loud'")
                retained()
                val lead = web.evaluate(scenario, "window.__dj.items[1].key")
                command("action:'djRequest',tracks:[{source:'local',id:'member-pcm-soft',title:'Listener request',artist:'member artist',duration:20}]")
                waitFor("window.__dj.items.some(i=>i.title==='Listener request') && ['ready','degraded'].includes(window.__dj.dj.phase)")
                val request = web.evaluate(scenario, "window.__dj.items.find(i=>i.title==='Listener request').key")
                menu("member softer PCM song", "Start DJ from current song")
                waitFor("window.__dj.dj.sources.length===1 && window.__dj.dj.sources[0].tracks[0].id==='member-pcm-soft' && !window.__dj.items.some(i=>i.key===" + lead + ")")
                retained()
                assertEquals("true", web.evaluate(scenario, "window.__dj.items.some(i=>i.key===" + request + ")"))
                val revision = web.evaluate(scenario, "window.__dj.dj.editRevision")
                menu("member louder PCM song", "Mix into session")
                waitFor("window.__dj.dj.sources.length===2")
                retained()
                assertEquals(revision, web.evaluate(scenario, "window.__dj.dj.editRevision"))
                assertEquals("true", web.evaluate(scenario, "window.__dj.items.some(i=>i.key===" + request + ")"))
                waitFor("['ready','degraded'].includes(window.__dj.dj.phase)")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-queue-key]')).find(row=>row.dataset.queueKey===" + request + ").querySelector('[data-row-menu]').click()")
                waitFor("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add to playlist')")
                assertEquals("true", web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.startsWith('Mix into session') && b.disabled)"))
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Remove from queue').click()")
                waitFor("!window.__dj.items.some(i=>i.key===" + request + ")")
                retained()
                command("action:'append',tracks:Array.from({length:20},(_,i)=>({source:'local',id:'member-pcm-soft',title:'Future '+i,artist:'member artist',duration:20}))")
                waitFor("window.__dj.items.length>=21")
                web.evaluate(scenario, "window.__fixedTarget=window.__dj.items[18].key;window.__fixedBefore=window.__dj.items.map(i=>i.key);window.__fixedRevision=window.__dj.dj.editRevision")
                menu("member louder PCM song", "Add to route")
                waitFor("!!document.querySelector('[data-testid=android-dj-placement] select')")
                web.evaluate(scenario, "let select=document.querySelector('[data-testid=android-dj-placement] select');select.value=window.__fixedTarget;select.dispatchEvent(new Event('change',{bubbles:true}));select.form.requestSubmit()")
                waitFor("window.__dj.dj.editRevision>window.__fixedRevision && window.__dj.dj.editOutcome==='placed'")
                assertEquals("true", web.evaluate(scenario, "(()=>{let target=window.__dj.items.findIndex(i=>i.key===window.__fixedTarget);let placed=window.__dj.items[target-1];return target>0 && placed.id==='member-pcm-loud' && !window.__fixedBefore.includes(placed.key)})()"))
                retained()
                web.evaluate(scenario, "window.__fixedRequest=window.__dj.items[window.__dj.items.findIndex(i=>i.key===window.__fixedTarget)-1].key;document.querySelector('[data-program-menu]').click()")
                waitFor("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Sources')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Sources').click()")
                waitFor("!!document.querySelector('[data-testid=android-dj-sources]')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-dj-sources] button')).find(b=>b.getAttribute('aria-label')==='Remove the member louder PCM song source').click()")
                waitFor("window.__dj.dj.sources.length===1 && document.querySelectorAll('[data-testid=android-dj-sources] button').length===1")
                assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-testid=android-dj-sources] button').disabled"))
                assertEquals("true", web.evaluate(scenario, "window.__dj.items.some(i=>i.key===window.__fixedRequest)"))
                retained()
            } finally {
                web.evaluate(scenario, "clearInterval(window.__djTimer)")
                val generation = connection.generation
                for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "context-cleanup-$id", 15000).close()
                connection.clearSession(true)
            }
        }
    }
}
