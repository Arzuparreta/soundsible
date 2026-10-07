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
public class LibraryActionsTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void menu(StartupTest web,ActivityScenario<MainActivity> scenario,String action) throws Exception {
        web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+").click()");
    }
    private JSONObject api(EngineConnection connection,String origin,String path) throws Exception {
        try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+path).header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){
            assertEquals(200,response.code());return new JSONObject(response.body().string());
        }
    }
    @Test public void httpLibraryActions() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsLibraryActions() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);
        StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
            menu(web,scenario,"Add to favourites");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-music-list-row]')).some(row=>row.textContent.includes('member private song') && row.querySelector('[data-row-main]').getAttribute('aria-label').includes('Favourites'))");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==='Favourites').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song')");
            menu(web,scenario,"Remove from favourites");
            waitFor(web,scenario,"!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==='Songs').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song')");
            menu(web,scenario,"Add to playlist");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-playlist-picker]')");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-playlist-picker] button').click()");
            waitFor(web,scenario,"!!document.querySelector('input[placeholder]')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('input')).find(i=>i.closest('form')).value='Android confirmed playlist';Array.from(document.querySelectorAll('input')).find(i=>i.closest('form')).dispatchEvent(new Event('input',{bubbles:true}));Array.from(document.querySelectorAll('input')).find(i=>i.closest('form')).form.requestSubmit()");
            waitFor(web,scenario,"!document.querySelector('[data-testid=android-playlist-picker]')");
            var ids=api(connection,origin,"/api/library").getJSONObject("playlists").getJSONArray("Android confirmed playlist");
            assertEquals(1,ids.length());assertEquals("member-track",ids.getString(0));
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Sign out').click()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='owner';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='owner private song')");
            assertFalse(api(connection,origin,"/api/library").getJSONObject("playlists").has("Android confirmed playlist"));
        }finally{connection.clearSession(true);}
    }
}
