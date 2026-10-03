package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Packaged search -> explicit bookmark -> native preview -> Library, using real engine routes. */
@RunWith(AndroidJUnit4.class)
public class CatalogSearchTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until) { if("true".equals(web.evaluate(scenario,condition))) return;Thread.sleep(100); }
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText")+" "+web.evaluate(scenario,"JSON.stringify(window.__catalog)"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String body) throws Exception {
        okhttp3.Request.Builder request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration());if(cookie!=null) request.header("Cookie",cookie);
        if(body!=null) request.post(okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json")));
        if(path.startsWith("/__fixture/")) request.header("X-Android-Fixture","isolated");
        try(okhttp3.Response response=connection.getClient().newCall(request.build()).execute()) {assertEquals(200,response.code());return new JSONObject(response.body().string());}
    }
    private boolean saved(EngineConnection connection,String origin,String video) throws Exception {
        var entries=api(connection,origin,"/api/library/saved",null).getJSONArray("saved");
        for(int i=0;i<entries.length();i++) if(entries.getJSONObject(i).getJSONArray("keys").toString().contains("yt:"+video)) return true;
        return false;
    }
    private void awaitSaved(EngineConnection connection,String origin,String video,boolean expected) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while(saved(connection,origin,video)!=expected) {assertTrue(System.nanoTime()<until);Thread.sleep(100);}
    }
    private void signIn(StartupTest web,ActivityScenario<MainActivity> scenario,String name) throws Exception {
        waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
        web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value="+JSONObject.quote(name)+";document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==="+JSONObject.quote(name+" private song")+")");
    }
    private void menu(StartupTest web,ActivityScenario<MainActivity> scenario,String title,String action) throws Exception {
        waitFor(web,scenario,"!!document.querySelector('[aria-label="+JSONObject.quote("More options: "+title)+"]') && document.querySelector('[aria-label="+JSONObject.quote("More options: "+title)+"]').closest('[data-music-list-row]').getAttribute('aria-busy')!=='true'");
        web.evaluate(scenario,"document.querySelector('[aria-label="+JSONObject.quote("More options: "+title)+"]').click()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith("+JSONObject.quote(action)+"))");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent.startsWith("+JSONObject.quote(action)+")).click()");
    }
    @Test public void httpSearchAndExplicitSaved() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void verifiedTlsSearchAndExplicitSaved() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();EngineConnection connection=EngineConnection.shared(context);connection.clearSession(true);
        StartupTest web=new StartupTest();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            signIn(web,scenario,"member");int acquired=api(connection,origin,"/api/library",null).getJSONArray("tracks").length();
            web.evaluate(scenario,"window.__catalogTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__catalog=s),100);document.querySelector('[data-android-discover]').click();document.querySelector('[data-testid=android-catalog-search] input').value='fixture';document.querySelector('[data-testid=android-catalog-search] input').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture direct song') && !!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song')");
            assertEquals("true",web.evaluate(scenario,"document.body.innerText.includes('Some sources could not answer')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture direct song').click()");
            waitFor(web,scenario,"window.__catalog?.id==='A1111111111' && window.__catalog.playing");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio') || performance.getEntriesByType('resource').some(e=>e.name.includes('authenticated-runtime'))"));
            menu(web,scenario,"fixture direct song","Save to your library");awaitSaved(connection,origin,"A1111111111",true);
            menu(web,scenario,"fixture direct song","Remove from your library");awaitSaved(connection,origin,"A1111111111",false);
            menu(web,scenario,"fixture resolved song","Save to your library");awaitSaved(connection,origin,"C1111111111",true);
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song').click()");
            waitFor(web,scenario,"window.__catalog?.id==='C1111111111' && window.__catalog.playing");
            assertEquals("true",web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song').closest('[data-music-list-row]').hasAttribute('data-now-playing')"));
            assertEquals(acquired,api(connection,origin,"/api/library",null).getJSONArray("tracks").length());
            assertFalse(api(connection,origin,"/api/android-fixture/catalog-stats",null).getJSONArray("requests").toString().contains("/api/catalog/save"));
            api(connection,origin,"/__fixture/catalog","{\"status\":403}");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-catalog-search] input').value='fixture denied';document.querySelector('[data-testid=android-catalog-search] input').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-catalog-search] [role=alert]')");
            api(connection,origin,"/__fixture/catalog","{\"status\":0}");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-catalog-search] button')).find(b=>b.textContent==='Retry').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture direct song')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");
            signIn(web,scenario,"owner");assertFalse(saved(connection,origin,"C1111111111"));
            waitFor(web,scenario,"window.__catalog?.items.length===0");
            assertEquals("false",web.evaluate(scenario,"document.body.innerText.includes('fixture resolved song')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");
            signIn(web,scenario,"member");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song').click()");
            waitFor(web,scenario,"window.__catalog?.id==='C1111111111' && window.__catalog.playing");
            api(connection,origin,"/api/library/saved/set","{\"entries\":[{\"title\":\"fixture resolved song\",\"keys\":[\"yt:C1111111111\"]}],\"saved\":false}");
        } finally {
            if(!connection.getOrigin().isEmpty()) {api(connection,origin,"/__fixture/catalog","{\"status\":0}");if(connection.cookieHeader(connection.getGeneration())!=null) api(connection,origin,"/api/library/saved/set","{\"entries\":[{\"title\":\"fixture\",\"keys\":[\"yt:A1111111111\"]},{\"title\":\"fixture\",\"keys\":[\"yt:C1111111111\"]}],\"saved\":false}");}
            connection.clearSession(true);
        }
    }
}
