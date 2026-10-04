package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** Actual packaged menus, durable complete files and native playback with every engine API unavailable. */
@RunWith(AndroidJUnit4.class)
public class OfflineTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<deadline) { if("true".equals(web.evaluate(scenario,condition))) return; Thread.sleep(100); }
        fail(condition+" body="+web.evaluate(scenario,"document.body.innerText")+" state="+web.evaluate(scenario,"JSON.stringify(window.__offline)")+" errors="+web.evaluate(scenario,"window.__offlineError")+" playback="+web.evaluate(scenario,"JSON.stringify(window.__play)")+" click="+web.evaluate(scenario,"JSON.stringify(window.__offlineClick)"));
    }
    private void control(EngineConnection connection,String origin,String action,String body) throws Exception {
        try(okhttp3.Response response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/"+action).header("X-Android-Fixture","isolated").post(okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json"))).build()).execute()) { assertEquals(200,response.code()); }
    }
    private int requests(EngineConnection connection,String origin) throws Exception {
        try(okhttp3.Response response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/android-fixture/audio-stats").header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()) { assertEquals(200,response.code()); return new JSONObject(response.body().string()).getInt("total"); }
    }
    private void observe(StartupTest web,ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario,"window.addEventListener('error',e=>window.__offlineError=e.message);window.__offlineTimer && clearInterval(window.__offlineTimer);window.__offlineTimer=setInterval(()=>Capacitor.Plugins.SoundsibleOffline.command({action:'state',generation:"+EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext()).getGeneration()+"}).then(s=>window.__offline=s),200);window.__playTimer && clearInterval(window.__playTimer);window.__playTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__play=s),200)");
    }
    private void click(StartupTest web,ActivityScenario<MainActivity> scenario,String label) throws Exception {
        String button = "Array.from(document.querySelectorAll('button')).find(b=>!b.disabled&&b.textContent==="+JSONObject.quote(label)+")";
        waitFor(web, scenario, "!!" + button + "&&!document.documentElement.hasAttribute('data-booting')");
        web.evaluate(scenario,"(()=>{const button="+button+";window.__offlineClick={label:"+JSONObject.quote(label)+",disabled:button.disabled,programBusy:document.querySelector('[data-testid=android-program]')?.getAttribute('aria-busy')};button.click()})()");
    }
    private void prepare(StartupTest web,ActivityScenario<MainActivity> scenario,long gen) throws Exception {
        web.evaluate(scenario,"window.__prepared=false;Capacitor.Plugins.SoundsibleOffline.command({action:'prepare',generation:"+gen+",tracks:[{id:'member-track',title:'member private song',artist:'member artist',album:'member album',podcast_episode_guid:null}],playlists:{}}).then(s=>{window.__offline=s;window.__prepared=true})");
        waitFor(web,scenario,"window.__prepared===true");
    }
    @Test public void httpExplicitOffline() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void verifiedTlsExplicitOffline() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection connection=EngineConnection.shared(context);connection.clearSession(true);
        OfflineStore store=connection.getOffline();
        StartupTest web=new StartupTest();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");observe(web,scenario);
            // No standalone preparation button in the library shell.
            assertEquals("false",web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Available offline')"));
            click(web,scenario,"Playlists");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist').click()");
            waitFor(web,scenario,"!!document.querySelector('[data-collection-menu]')");web.evaluate(scenario,"document.querySelector('[data-collection-menu]').click()");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Available offline')");click(web,scenario,"Available offline");
            waitFor(web,scenario,"window.__offline?.items.length===1 && window.__offline.items[0].state==='ready'");
            long gen=connection.getGeneration();assertNotNull(store.local("member-track",gen));assertEquals(1,store.state(gen).getJSONArray("items").length());
            int before=requests(connection,origin);
            control(connection,origin,"connection-failure","{\"enabled\":true,\"status\":503}");
            scenario.recreate();waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");observe(web,scenario);
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('input[type=password]')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song').click()");
            waitFor(web,scenario,"window.__play?.playing && window.__play.id==='member-track' && window.__play.items[0].offline===true");
            click(web,scenario,"Pause");waitFor(web,scenario,"window.__play?.playWhenReady===false");
            web.evaluate(scenario,"(()=>{const seek=document.querySelector('input[type=range]');seek.value=15000;seek.dispatchEvent(new Event('input',{bubbles:true}));seek.dispatchEvent(new Event('change',{bubbles:true}))})()");
            waitFor(web,scenario,"window.__play?.positionMs>=14500 && !window.__play.playWhenReady");
            scenario.recreate();observe(web,scenario);waitFor(web,scenario,"window.__play?.id==='member-track' && !window.__play.playWhenReady");
            click(web,scenario,"Play");waitFor(web,scenario,"window.__play?.playing");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"document.querySelector('[data-program-close]').click()");waitFor(web,scenario,"window.__play?.items.length===0");
            control(connection,origin,"connection-failure","{\"enabled\":false}");assertEquals(before,requests(connection,origin));
            // Invalid batches do not alter existing copies; previews cannot be acquired implicitly.
            try { store.prepare(gen,new JSONArray("[{\"id\":\"A1111111111\",\"source\":\"preview\"}]"),new JSONObject());fail("preview accepted"); } catch(IllegalArgumentException expected) {}
            assertEquals(1,store.state(gen).getJSONArray("items").length());
            // Removal is local. Failure/partial download is never ready and remains explicitly recoverable.
            store.remove(gen,new JSONArray().put("member-track"));assertNull(store.local("member-track",gen));
            store.limit(gen,512L*1024*1024);
            control(connection,origin,"offline-body","{\"mode\":\"oversize\"}");prepare(web,scenario,gen);
            waitFor(web,scenario,"window.__offline?.items[0]?.error==='space'");assertNull(store.local("member-track",gen));
            control(connection,origin,"offline-body","{\"mode\":\"\"}");
            control(connection,origin,"stream-cut","{\"enabled\":true}");
            prepare(web,scenario,gen);
            waitFor(web,scenario,"window.__offline?.items[0]?.state==='error'");assertNull(store.local("member-track",gen));
            control(connection,origin,"stream-cut","{\"enabled\":false}");
            control(connection,origin,"offline-body","{\"mode\":\"invalid\"}");
            prepare(web,scenario,gen);
            waitFor(web,scenario,"window.__offline?.items[0]?.error==='integrity'");assertNull(store.local("member-track",gen));
            control(connection,origin,"offline-body","{\"mode\":\"\"}");
            control(connection,origin,"stream-delay","{\"enabled\":true}");
            prepare(web,scenario,gen);
            waitFor(web,scenario,"window.__offline?.items[0]?.state==='downloading'");store.remove(gen,new JSONArray().put("member-track"));Thread.sleep(5500);
            assertEquals(0,store.state(gen).getJSONArray("items").length());
            control(connection,origin,"stream-delay","{\"enabled\":false}");
            prepare(web,scenario,gen);waitFor(web,scenario,"window.__offline?.items[0]?.state==='ready'");assertNotNull(store.local("member-track",gen));
            // Explicit logout erases ready private copies even when no API is reachable.
            control(connection,origin,"connection-failure","{\"enabled\":true,\"status\":503}");click(web,scenario,"Sign out");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");assertEquals(0,store.state(connection.getGeneration()).getJSONArray("items").length());
            assertFalse(new java.io.File(context.getFilesDir(),"offline").listFiles().length>0);
        } finally { control(connection,origin,"connection-failure","{\"enabled\":false}");control(connection,origin,"stream-cut","{\"enabled\":false}");control(connection,origin,"stream-delay","{\"enabled\":false}");control(connection,origin,"offline-body","{\"mode\":\"\"}");connection.clearSession(true); }
    }
}
