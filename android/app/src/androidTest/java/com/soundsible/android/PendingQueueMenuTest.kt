package com.soundsible.android
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
/** An unresolved catalogue occurrence is not a library song: its queue menu offers removal only, never song/DJ/offline actions. */
class PendingQueueMenuTest {
    @Test fun httpPendingQueueMenu() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsPendingQueueMenu() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().targetContext)
        connection.clearSession(true); connection.configure(origin)
        connection.execute("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test").toString().toRequestBody("application/json".toMediaType()),
            emptyMap(), connection.generation, "pending-menu", 15000).use { check(it.isSuccessful) { "login ${it.code}" } }
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < until) { if (web.evaluate(scenario, condition) == "true") return; Thread.sleep(100) }
                    fail("Pending menu condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')&&!document.documentElement.hasAttribute('data-booting')")
                web.evaluate(scenario, "window.__pendingTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__pendingState=s),100)")
                waitFor("window.__pendingState?.ready")
                val pending = JSONObject().put("source", "pending").put("id", "deezer:track:900002").put("title", "unresolved fixture future").put("artist", "fixture artist")
                    .put("pendingResolve", JSONObject().put("catalogItemId", "deezer:track:900002").put("artist", "fixture artist").put("title", "unresolved fixture future").put("duration", 60))
                web.evaluate(scenario, "window.__pendingDone=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__pendingState,action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'Current local',artist:'member artist',duration:180},$pending]}).then(()=>Capacitor.Plugins.SoundsiblePlayback.command({...window.__pendingState,action:'pause'})).then(()=>window.__pendingDone=true)")
                waitFor("window.__pendingDone&&window.__pendingState.items.length===2&&window.__pendingState.items[1].source==='pending'")
                val key = web.evaluate(scenario, "window.__pendingState.items[0].key")
                fun menu(title: String) = "(()=>{const row=Array.from(document.querySelectorAll('[data-testid=program-queue] [data-queue-key]')).find(r=>r.textContent.includes(${JSONObject.quote(title)}));row?.querySelector('[data-row-menu]')?.click();return !!row})()"
                fun labels() = "JSON.stringify(Array.from(document.querySelectorAll('[role=dialog] button[data-pressable]')).map(b=>b.textContent.trim()).filter(Boolean))"
                waitFor(menu("Current local"))
                waitFor("!!document.querySelector('[role=dialog]')")
                val local = web.evaluate(scenario, labels())
                assertTrue("Local occurrence lost song actions: $local", local.contains("Share") && local.contains("Remove from queue"))
                web.evaluate(scenario, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))")
                waitFor("!document.querySelector('[role=dialog]')")
                waitFor(menu("unresolved fixture future"))
                waitFor("!!document.querySelector('[role=dialog]')")
                assertEquals("Pending occurrence exposed song actions: " + web.evaluate(scenario, labels()), "true", web.evaluate(scenario, labels() + "===JSON.stringify(['Remove from queue'])"))
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[role=dialog] button[data-pressable]')).find(b=>b.textContent.trim()==='Remove from queue').click()")
                waitFor("window.__pendingState.items.length===1&&!window.__pendingState.items.some(item=>item.source==='pending')")
                assertEquals(key, web.evaluate(scenario, "window.__pendingState.items[0].key"))
                assertEquals("false", web.evaluate(scenario, "window.__pendingState.playWhenReady"))
            }
        } finally { connection.clearSession(true) }
    }
}
