package com.soundsible.android

import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit

/** Actual cold/warm intents; arrival does not connect an account or alter native playback. */
class IncomingTrackTest {
    @Test fun httpIncomingSong() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsIncomingSong() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        fun clearPending() { IncomingTrackState.pending(context)?.getString("token")?.let { IncomingTrackState.dismiss(context, it) } }
        fun capsule(title: String) = Base64.encodeToString(JSONObject().put("v",1).put("kind","music").put("yt","A1111111111").put("title",title).put("artist","Artist").toString().toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        fun view(title: String) = Intent(Intent.ACTION_VIEW, Uri.parse("soundsible://open?shared=" + capsule(title))).setClass(context, MainActivity::class.java)
        connection.clearSession(true); clearPending()
        val web = StartupTest()
        try {
            ActivityScenario.launch<MainActivity>(view("Cold song")).use { scenario ->
                fun waitFor(condition: String) {
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
                    while (System.nanoTime() < deadline) {
                        if (web.evaluate(scenario, condition) == "true") return
                        Thread.sleep(100)
                    }
                    fail("Incoming condition: $condition; " + web.evaluate(scenario, "document.body.innerText"))
                }
                web.awaitReady(scenario)
                waitFor("document.querySelector('[data-testid=android-shared-song]')?.textContent.includes('Cold song')===true")
                assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-shared-play]').disabled"))
                assertNull(connection.sessionIdentity(connection.generation))
                web.evaluate(scenario, "localStorage.setItem('lang','en')")
                scenario.recreate(); web.awaitReady(scenario)
                waitFor("!!document.querySelector('[data-testid=android-shared-song]')")
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor("!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor("!!document.querySelector('[data-testid=android-library]')")
                web.evaluate(scenario, "window.__incomingTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__incomingState=s),100)")
                waitFor("window.__incomingState?.ready")
                assertEquals("0", web.evaluate(scenario, "window.__incomingState.items.length"))
                web.evaluate(scenario, "window.__incomingDone=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__incomingState,action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'Retained song',artist:'member artist',duration:180}]}).then(()=>window.__incomingDone=true)")
                waitFor("window.__incomingDone && window.__incomingState.playing")
                web.evaluate(scenario, "window.__incomingDone=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__incomingState,action:'pause'}).then(()=>window.__incomingDone=true)")
                waitFor("window.__incomingDone && !window.__incomingState.playWhenReady")
                val key = web.evaluate(scenario, "window.__incomingState.items[window.__incomingState.index].key")
                val position = web.evaluate(scenario, "window.__incomingState.positionMs").toDouble()
                val oldToken = requireNotNull(IncomingTrackState.pending(context)!!.getString("token"))
                context.startActivity(view("Warm song").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                waitFor("document.querySelector('[data-testid=android-shared-song]')?.textContent.includes('Warm song')===true")
                assertFalse(IncomingTrackState.dismiss(context, oldToken))
                assertEquals(key, web.evaluate(scenario, "window.__incomingState.items[window.__incomingState.index].key"))
                assertEquals("false", web.evaluate(scenario, "window.__incomingState.playWhenReady"))
                assertEquals(position, web.evaluate(scenario, "window.__incomingState.positionMs").toDouble(), 150.0)
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Sent song — Artist\nhttps://arzuparreta.github.io/soundsible.github.io/open/#t=" + capsule("Sent song")).setClass(context, MainActivity::class.java)
                context.startActivity(send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                waitFor("document.querySelector('[data-testid=android-shared-song]')?.textContent.includes('Sent song')===true")
                val currentToken = IncomingTrackState.pending(context)!!.getString("token")
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("soundsible://open?shared=x&server=https://private.invalid")).setClass(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                instrumentation.waitForIdleSync()
                assertEquals(currentToken, IncomingTrackState.pending(context)!!.getString("token"))
                assertEquals(key, web.evaluate(scenario, "window.__incomingState.items[window.__incomingState.index].key"))
                web.evaluate(scenario, "document.querySelector('[data-shared-play]').click()")
                waitFor("!document.querySelector('[data-testid=android-shared-song]') && window.__incomingState.items[window.__incomingState.index]?.id==='A1111111111' && window.__incomingState.playing")
                assertNull(IncomingTrackState.pending(context))
                web.evaluate(scenario, "clearInterval(window.__incomingTimer)")
                scenario.recreate()
                waitFor("!!document.querySelector('[data-testid=android-library]')")
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('[data-testid=android-shared-song]')"))
                assertNull(IncomingTrackState.pending(context))
            }
        } finally { clearPending(); connection.clearSession(true) }
    }
}
