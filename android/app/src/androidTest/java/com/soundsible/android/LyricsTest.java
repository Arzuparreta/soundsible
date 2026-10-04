package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** Cached real engine lyrics, shared Solid panel, authoritative native seek and account teardown. */
@RunWith(AndroidJUnit4.class)
public class LyricsTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    @Test public void httpLyrics() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsLyrics() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').click();window.__lyricsTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__lyricsState=s),100)");
            waitFor(web,scenario,"window.__lyricsState?.playing && window.__lyricsState?.ready");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-program] button')).find(b=>b.textContent==='Pause').click()");
            waitFor(web,scenario,"!window.__lyricsState.playWhenReady");
            String token=web.evaluate(scenario,"window.__lyricsState.queueToken"),keys=web.evaluate(scenario,"JSON.stringify(window.__lyricsState.items.map(i=>i.key))");
            web.evaluate(scenario,"document.querySelector('[data-program-menu]').click()");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Show lyrics')");web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Show lyrics').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-native-lyrics] button[data-line]')).find(b=>b.textContent==='member second line')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-native-lyrics] button[data-line]')).find(b=>b.textContent==='member second line').click()");
            waitFor(web,scenario,"Math.abs(window.__lyricsState.positionMs-20000)<1000 && document.querySelector('[data-native-lyrics] [data-line=\"1\"]')?.getAttribute('aria-current')==='true'");
            assertEquals(token,web.evaluate(scenario,"window.__lyricsState.queueToken"));assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__lyricsState.items.map(i=>i.key))"));assertEquals("true",web.evaluate(scenario,"!window.__lyricsState.playWhenReady"));assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-native-lyrics] button')).find(b=>b.textContent==='Close').click()");waitFor(web,scenario,"!document.querySelector('[data-native-lyrics]')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member saved song').click()");
            waitFor(web,scenario,"window.__lyricsState?.id==='B1111111111' && window.__lyricsState.playing && window.__lyricsState.ready");
            web.evaluate(scenario,"document.querySelector('[data-program-menu]').click()");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Show lyrics')");web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Show lyrics').click()");
            waitFor(web,scenario,"document.querySelector('[data-native-lyrics]')?.textContent.includes('member preview words')");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('[data-native-lyrics] [data-line]')"));
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-native-lyrics] button')).find(b=>b.textContent==='Close').click()");waitFor(web,scenario,"!document.querySelector('[data-native-lyrics]')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]') && !document.querySelector('[data-native-lyrics]') && !document.querySelector('[data-testid=android-program]')");
            web.evaluate(scenario,"clearInterval(window.__lyricsTimer)");
        }finally{connection.clearSession(true);}
    }
}
