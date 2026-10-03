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

@RunWith(AndroidJUnit4.class)
public class PlaylistManagementTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String body) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path).header("Cookie",connection.cookieHeader(connection.getGeneration()));
        if(body!=null)request.post(okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(request.build()).execute()){assertEquals(200,response.code());return new JSONObject(response.body().string());}
    }
    private void choose(StartupTest web,ActivityScenario<MainActivity> scenario,String action) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+").click()");
    }
    private void rowMenu(StartupTest web,ActivityScenario<MainActivity> scenario,String name,int index,String action) throws Exception {
        web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).filter(b=>b.textContent==="+JSONObject.quote(name)+")["+index+"].closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");choose(web,scenario,action);
    }
    private void prompt(StartupTest web,ActivityScenario<MainActivity> scenario,String value) throws Exception {
        waitFor(web,scenario,"!!document.querySelector('form input')");
        web.evaluate(scenario,"document.querySelector('form input').value="+JSONObject.quote(value)+";document.querySelector('form input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
    }
    private void awaitIds(EngineConnection connection,String origin,String name,String expected) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(true){String actual=String.valueOf(api(connection,origin,"/api/library",null).getJSONObject("playlists").optJSONArray(name));if(actual.equals(expected))return;assertTrue("Expected "+expected+" but server holds "+actual,System.nanoTime()<until);Thread.sleep(100);}
    }
    @Test public void httpManagement() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsManagement() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            api(connection,origin,"/api/library/playlists/member%20playlist/tracks","{\"track_id\":\"B1111111111\"}");
            choose(web,scenario,"Refresh");Thread.sleep(500);choose(web,scenario,"Playlists");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist').click()");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-row-main]')).filter(b=>b.textContent==='member private song').length===2");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member saved song')");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-library] input[type=search]').value='private';document.querySelector('[data-testid=android-library] input[type=search]').dispatchEvent(new Event('input',{bubbles:true}))");
            rowMenu(web,scenario,"member private song",1,"Remove from playlist");awaitIds(connection,origin,"member playlist","[\"member-track\",\"B1111111111\"]");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-row-main]')).filter(b=>b.textContent==='member private song').length===1");
            rowMenu(web,scenario,"member private song",0,"Move down");awaitIds(connection,origin,"member playlist","[\"B1111111111\",\"member-track\"]");
            // Server acknowledgement precedes the refreshed UI. Observe the new order
            // before capturing the next conditional edit, including under TLS latency.
            web.evaluate(scenario,"document.querySelector('[data-testid=android-library] input[type=search]').value='';document.querySelector('[data-testid=android-library] input[type=search]').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"document.querySelector('[data-testid=android-library] [data-row-main]')?.textContent==='member saved song'");
            web.evaluate(scenario,"document.querySelector('[data-collection-menu]').click()");choose(web,scenario,"Change cover");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-playlist-cover] button[aria-label=\"member private song\"]')");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-playlist-cover] button[aria-label=\"member private song\"]').click()");waitFor(web,scenario,"!document.querySelector('[data-testid=android-playlist-cover]')");
            assertEquals("member-track",api(connection,origin,"/api/library",null).getJSONObject("settings").getJSONObject("playlist_covers").getString("member playlist"));
            web.evaluate(scenario,"document.querySelector('[data-collection-menu]').click()");choose(web,scenario,"Rename");prompt(web,scenario,"Managed playlist");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='Managed playlist')");
            rowMenu(web,scenario,"Managed playlist",0,"Duplicate");prompt(web,scenario,"Managed copy");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='Managed copy')");awaitIds(connection,origin,"Managed copy","[\"B1111111111\",\"member-track\"]");
            rowMenu(web,scenario,"Managed playlist",0,"Move up");
            waitFor(web,scenario,"document.querySelector('[data-testid=android-library] [data-row-main]')?.textContent==='Managed playlist'");
            assertEquals("Managed playlist",api(connection,origin,"/api/library",null).getJSONObject("settings").getJSONArray("playlist_order").getString(0));
            rowMenu(web,scenario,"Managed copy",0,"Delete playlist");choose(web,scenario,"Delete");
            waitFor(web,scenario,"!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='Managed copy')");
            var library=api(connection,origin,"/api/library",null);assertFalse(library.getJSONObject("playlists").has("Managed copy"));assertTrue(library.getJSONArray("tracks").length()>0);
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        }finally{connection.clearSession(true);}
    }
}
