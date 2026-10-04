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

/** Bookmarks are account-owned navigation; acquired songs and playlists do not change. */
@RunWith(AndroidJUnit4.class)
public class EntityBookmarksTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject get(EngineConnection connection,String origin,String path) throws Exception {
        try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+path).header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){
            assertEquals(200,response.code());return new JSONObject(response.body().string());
        }
    }
    private boolean marked(EngineConnection connection,String origin,String kind,String name) throws Exception {
        var entries=get(connection,origin,"/api/library/saved-entities").getJSONArray("entities");
        for(int i=0;i<entries.length();i++){var entry=entries.getJSONObject(i);if(entry.getString("kind").equals(kind)&&entry.getString("name").equals(name))return true;}
        return false;
    }
    private void awaitMarked(EngineConnection connection,String origin,String kind,String name,boolean expected) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(marked(connection,origin,kind,name)!=expected){assertTrue(System.nanoTime()<until);Thread.sleep(100);}
    }
    private void signIn(StartupTest web,ActivityScenario<MainActivity> scenario,String name) throws Exception {
        waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
        web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value="+JSONObject.quote(name)+";document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
        waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]') && document.body.innerText.includes("+JSONObject.quote(name+" private song")+")");
    }
    private void tab(StartupTest web,ActivityScenario<MainActivity> scenario,String name) throws Exception {
        web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==="+JSONObject.quote(name)+").click()");
    }
    private void menu(StartupTest web,ActivityScenario<MainActivity> scenario,String title,String action) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==="+JSONObject.quote(title)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==="+JSONObject.quote(title)+").closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith("+JSONObject.quote(action)+"))");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith("+JSONObject.quote(action)+")).click()");
    }
    @Test public void httpBookmarks() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsBookmarks() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            signIn(web,scenario,"member");var before=get(connection,origin,"/api/library");String playlists=before.getJSONObject("playlists").toString();int tracks=before.getJSONArray("tracks").length();String songs=get(connection,origin,"/api/library/saved").toString();
            tab(web,scenario,"Albums");menu(web,scenario,"member album","Save");awaitMarked(connection,origin,"album","member album",true);
            scenario.recreate();waitFor(web,scenario,"!document.documentElement.hasAttribute('data-booting') && !!document.querySelector('[data-testid=android-library]')");
            tab(web,scenario,"Albums");menu(web,scenario,"member album","Remove from saved");awaitMarked(connection,origin,"album","member album",false);
            tab(web,scenario,"Artists");menu(web,scenario,"member artist","Save");awaitMarked(connection,origin,"artist","member artist",true);
            var after=get(connection,origin,"/api/library");assertEquals(tracks,after.getJSONArray("tracks").length());assertEquals(playlists,after.getJSONObject("playlists").toString());assertEquals(songs,get(connection,origin,"/api/library/saved").toString());
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");signIn(web,scenario,"owner");assertFalse(marked(connection,origin,"artist","member artist"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");signIn(web,scenario,"member");assertTrue(marked(connection,origin,"artist","member artist"));
            tab(web,scenario,"Artists");menu(web,scenario,"member artist","Remove from saved");awaitMarked(connection,origin,"artist","member artist",false);
            web.evaluate(scenario,"window.__bookmarkNative=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__bookmarkNative=s)");
            waitFor(web,scenario,"window.__bookmarkNative?.ready && window.__bookmarkNative.items.length===0");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        }finally{connection.clearSession(true);}
    }
}
