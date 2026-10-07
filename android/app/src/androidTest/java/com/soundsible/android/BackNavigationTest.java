package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.Intent;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** Real system Back through native routes/modals/root, retaining one paused program and account. */
@RunWith(AndroidJUnit4.class)
public class BackNavigationTest {
    private final android.app.Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void back() {
        long now=SystemClock.uptimeMillis();
        assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,now,KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_BACK,0,0,KeyCharacterMap.VIRTUAL_KEYBOARD,0,KeyEvent.FLAG_FROM_SYSTEM,InputDevice.SOURCE_KEYBOARD),true));
        SystemClock.sleep(80);
        assertTrue(instrumentation.getUiAutomation().injectInputEvent(new KeyEvent(now,SystemClock.uptimeMillis(),KeyEvent.ACTION_UP,KeyEvent.KEYCODE_BACK,0,0,KeyCharacterMap.VIRTUAL_KEYBOARD,0,KeyEvent.FLAG_FROM_SYSTEM,InputDevice.SOURCE_KEYBOARD),true));
        SystemClock.sleep(500);
    }
    private void action(StartupTest web,ActivityScenario<MainActivity> scenario,String name) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(name)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(name)+").click()");
    }
    private void awaitBackground() throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);String own=instrumentation.getTargetContext().getPackageName();
        while(System.nanoTime()<until){var root=instrumentation.getUiAutomation().getRootInActiveWindow();if(root!=null&&!own.equals(String.valueOf(root.getPackageName())))return;Thread.sleep(100);}
        fail("Root Back must minimize the app");
    }
    private void foreground(){var context=instrumentation.getTargetContext();context.startActivity(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));}
    private void fixture(EngineConnection connection,String origin,String action) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+"/__fixture/"+action).header("X-Android-Fixture","isolated").post(okhttp3.RequestBody.create("{\"account\":\"member\"}",okhttp3.MediaType.get("application/json"))).build();
        try(var response=connection.getClient().newCall(request).execute()){assertEquals(200,response.code());}
    }
    @Test public void httpBack() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsBack() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(instrumentation.getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').click();window.__backTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__backState=s),100)");
            waitFor(web,scenario,"window.__backState?.ready && window.__backState.playing");action(web,scenario,"Pause");waitFor(web,scenario,"!window.__backState.playWhenReady");
            web.evaluate(scenario,"Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,action:'seek',positionMs:20000}))");waitFor(web,scenario,"Math.abs(window.__backState.positionMs-20000)<1000");
            String keys=web.evaluate(scenario,"JSON.stringify(window.__backState.items.map(i=>i.key))"),token=web.evaluate(scenario,"window.__backState.queueToken"),cookie=connection.cookieHeader(connection.getGeneration());
            action(web,scenario,"Playlists");web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member playlist').click()");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('h2')).find(h=>h.textContent==='member playlist')");
            back();waitFor(web,scenario,"!Array.from(document.querySelectorAll('h2')).find(h=>h.textContent==='member playlist') && Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==='Playlists')?.getAttribute('aria-pressed')==='true'");
            back();waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==='Songs')?.getAttribute('aria-pressed')==='true'");
            web.evaluate(scenario,"document.querySelector('[data-browse-track-id=\"member-track\"] [data-row-menu]').click()");waitFor(web,scenario,"!!document.querySelector('[role=dialog]')");back();waitFor(web,scenario,"!document.querySelector('[role=dialog]')");
            web.evaluate(scenario,"document.querySelector('[data-browse-track-id=\"member-track\"] [data-row-menu]').click()");action(web,scenario,"Edit details");waitFor(web,scenario,"!!document.querySelector('[data-track-metadata-editor]')");back();waitFor(web,scenario,"!document.querySelector('[data-track-metadata-editor]')");
            web.evaluate(scenario,"document.querySelector('[data-program-menu]').click()");action(web,scenario,"Show lyrics");waitFor(web,scenario,"!!document.querySelector('[data-native-lyrics]')");back();waitFor(web,scenario,"!document.querySelector('[data-native-lyrics]')");
            web.evaluate(scenario,"document.querySelector('[data-android-podcasts]').click();const input=document.querySelector('[data-testid=android-podcast-directory] input');input.value='fixture';input.dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-podcast-directory] [data-row-main]')).find(b=>b.textContent==='fixture directory podcast')");web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcast-directory] [data-row-main]')).find(b=>b.textContent==='fixture directory podcast').click()");waitFor(web,scenario,"!!document.querySelector('[data-podcast-show-menu]')");
            back();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-podcast-directory]') && !document.querySelector('[data-podcast-show-menu]')");back();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            web.evaluate(scenario,"document.querySelector('[data-android-downloads]').click()");back();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            back();awaitBackground();foreground();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]') && !document.documentElement.hasAttribute('data-booting') && window.__backState?.ready");
            assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__backState.items.map(i=>i.key))"));assertEquals(token,web.evaluate(scenario,"window.__backState.queueToken"));assertEquals("true",web.evaluate(scenario,"!window.__backState.playWhenReady && Math.abs(window.__backState.positionMs-20000)<1000"));assertTrue("Back preserves the private session",java.util.Objects.equals(cookie,connection.cookieHeader(connection.getGeneration())));assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"document.querySelector('[data-browse-track-id=\"member-track\"] [data-row-menu]').click()");waitFor(web,scenario,"!!document.querySelector('[role=dialog]')");fixture(connection,origin,"revoke");fixture(connection,origin,"event");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]') && !document.querySelector('[role=dialog]') && !document.body.innerText.includes('member private song')");waitFor(web,scenario,"window.__backState?.queue.length===0");web.evaluate(scenario,"clearInterval(window.__backTimer)");
        }finally{connection.clearSession(true);}
    }
}
