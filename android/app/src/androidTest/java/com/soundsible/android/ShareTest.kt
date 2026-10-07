package com.soundsible.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Intercept the OS chooser: exercise the real menu/plugin without sending to a recipient. */
class ShareTest {
    @Test fun httpSongShare() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsSongShare() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val connection = EngineConnection.shared(instrumentation.targetContext)
        connection.clearSession(true)
        val captured = AtomicReference<Intent>()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_CHOOSER) return null
                captured.set(intent)
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        val web = StartupTest()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun waitFor(condition: String) {
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < deadline) {
                        if (web.evaluate(scenario, condition) == "true") return
                        Thread.sleep(100)
                    }
                    fail("Share condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                fun waitChooser(): Intent {
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (captured.get() == null && System.nanoTime() < deadline) Thread.sleep(50)
                    val chooser = captured.get(); assertNotNull("No OS chooser launched", chooser)
                    @Suppress("DEPRECATION")
                    val send = chooser!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
                    assertEquals(Intent.ACTION_SEND, send.action); assertEquals("text/plain", send.type)
                    assertFalse(send.hasExtra(Intent.EXTRA_STREAM))
                    assertEquals(0, send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    assertFalse(send.hasExtra("generation")); assertFalse(send.hasExtra("Cookie"))
                    return send
                }
                web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')")
                scenario.recreate(); web.awaitReady(scenario)
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).some(b=>b.textContent==='member private song')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()")
                waitFor("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Share')")
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Share').click()")
                val plain = waitChooser(); assertEquals("member private song", plain.getStringExtra(Intent.EXTRA_TITLE))
                assertEquals("member private song — member artist", plain.getStringExtra(Intent.EXTRA_TEXT))
                captured.set(null)
                web.evaluate(scenario, "window.__shared=false;window.__shareError=null;Capacitor.Plugins.SoundsibleEngine.state().then(s=>{window.__shareGen=s.generation;return Capacitor.Plugins.SoundsibleShare.open({generation:s.generation,title:'Shared song',text:'Shared song — Artist',url:'https://arzuparreta.github.io/soundsible.github.io/open/#t='+btoa(JSON.stringify({v:1,kind:'music',yt:'dQw4w9WgXcQ',title:'Shared song',artist:'Artist'})).replace(/=/g,'').replace(/\\+/g,'-').replace(/\\//g,'_')})}).then(r=>window.__shared=r.opened).catch(e=>window.__shareError=e.code)")
                waitFor("window.__shared || !!window.__shareError"); assertEquals("true", web.evaluate(scenario, "window.__shared"))
                val rich = waitChooser().getStringExtra(Intent.EXTRA_TEXT)!!
                assertTrue(rich.startsWith("Shared song — Artist\nhttps://")); assertTrue(rich.contains("/open/#t="))
                assertFalse(rich.contains(origin!!)); assertFalse(rich.contains("android_generation")); assertFalse(rich.contains("Cookie"))
                captured.set(null)
                web.evaluate(scenario, "window.__shareError=null;Capacitor.Plugins.SoundsibleShare.open({generation:window.__shareGen-1,title:'Stale',text:'Stale'}).catch(e=>window.__shareError=e.code)")
                waitFor("!!window.__shareError"); assertEquals("\"SHARE_SESSION_CHANGED\"", web.evaluate(scenario, "window.__shareError")); assertNull(captured.get())
                web.evaluate(scenario, "window.__shareError=null;Capacitor.Plugins.SoundsibleShare.open({generation:window.__shareGen,title:'Invalid',text:'Invalid',url:'https://private.invalid/api/stream?token=synthetic'}).catch(e=>window.__shareError=e.code)")
                waitFor("!!window.__shareError"); assertEquals("\"INVALID_SHARE\"", web.evaluate(scenario, "window.__shareError")); assertNull(captured.get())
            }
        } finally { instrumentation.removeMonitor(monitor); connection.clearSession(true) }
    }
}
