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

/** Real Core entity routes and bulk saves, with one native playback owner. */
@RunWith(AndroidJUnit4.class)
public class CollectionProfileTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until) { if("true".equals(web.evaluate(scenario,condition))) return; Thread.sleep(100); }
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path) throws Exception {
        okhttp3.Request.Builder request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration()); if(cookie!=null) request.header("Cookie",cookie);
        try(okhttp3.Response response=connection.getClient().newCall(request.build()).execute()) {
            assertEquals(200,response.code()); return new JSONObject(response.body().string());
        }
    }
    private void click(StartupTest web, ActivityScenario<MainActivity> scenario, String label) throws Exception {
        String find="Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length>0 && !b.disabled && (b.getAttribute('aria-label')==="+JSONObject.quote(label)+" || b.textContent.trim()==="+JSONObject.quote(label)+"))";
        waitFor(web,scenario,"!!"+find); assertEquals("true",web.evaluate(scenario,find+".click();true"));
    }
    private void mutate(EngineConnection connection,String origin,String path,JSONObject body,String method) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration()); if(cookie!=null) request.header("Cookie",cookie);
        request.method(method,body==null?null:okhttp3.RequestBody.create(body.toString(),okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(request.build()).execute()) { assertEquals(200,response.code()); }
    }
    @Test public void httpCollectionAcquisition() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"),true);}
    @Test public void verifiedTlsCollectionAcquisition() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"),true);}
    @Test public void httpCollectionProfile() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"),false);}
    @Test public void verifiedTlsCollectionProfile() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"),false);}
    private void run(String origin,boolean acquire) throws Exception {
        assumeNotNull(origin); Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection connection=EngineConnection.shared(context); connection.clearSession(true); StartupTest web=new StartupTest(); org.json.JSONArray savedBefore=null;
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario,"localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('[data-android-discover]')");
            savedBefore=api(connection,origin,"/api/library/saved").getJSONArray("saved");
            int acquired=api(connection,origin,"/api/library").getJSONArray("tracks").length();
            web.evaluate(scenario,"window.__collectionTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__collection=s),100);document.querySelector('[data-android-discover]').click();document.querySelector('[data-testid=android-catalog-search] input').value='fixture collection';document.querySelector('[data-testid=android-catalog-search] input').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture collection artist')");
            web.evaluate(scenario,"const scroll=document.querySelector('main');scroll.scrollTop=300;window.__collectionReturnScroll=scroll.scrollTop");
            assertEquals("true",web.evaluate(scenario,"window.__collectionReturnScroll>0"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture collection artist').click()");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-entity-profile] h1') && !!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song')");
            click(web,scenario,"fixture collection album");
            waitFor(web,scenario,"document.querySelector('[data-testid=android-entity-profile] h1')?.textContent==='fixture collection album' && !!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='fixture resolved song')");
            click(web,scenario,"Play"); waitFor(web,scenario,"window.__collection?.id==='C1111111111' && window.__collection.playing");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"document.querySelector('[data-testid=android-entity-profile] header button[aria-label]').click()");
            click(web,scenario,"Add all songs");
            waitFor(web,scenario,"!!document.querySelector('[role=dialog]')");
            // Confirm the explicit song action; the entity bookmark remains separate.
            click(web,scenario,"Add all songs");
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15); boolean saved=false;
            while(System.nanoTime()<until) {
                var entries=api(connection,origin,"/api/library/saved").getJSONArray("saved");
                for(int i=0;i<entries.length();i++) if(entries.getJSONObject(i).getJSONArray("keys").toString().contains("deezer:900001")) saved=true;
                if(saved) break; Thread.sleep(100);
            }
            assertTrue(saved); assertEquals(acquired,api(connection,origin,"/api/library").getJSONArray("tracks").length());
            assertEquals("true",web.evaluate(scenario,"window.__collection?.playing && window.__collection.id==='C1111111111'"));
            if(acquire) {
                String occurrences=web.evaluate(scenario,"JSON.stringify(window.__collection.items.map(i=>i.key))");
                waitFor(web,scenario,"!!document.querySelector('[data-testid=android-entity-profile] header button[aria-label]') && !document.querySelector('[data-testid=android-entity-profile] header button[aria-label]').disabled && !document.querySelector('[role=dialog]')");
                web.evaluate(scenario,"document.querySelector('[data-testid=android-entity-profile] header button[aria-label]').click()");
                click(web,scenario,"Download the album");
                String acquiredId=null; JSONObject acquiredTrack=null;
                long downloadUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(50);
                while(System.nanoTime()<downloadUntil && acquiredId==null) {
                    var tracks=api(connection,origin,"/api/library").getJSONArray("tracks");
                    for(int i=0;i<tracks.length();i++) {var track=tracks.getJSONObject(i); if(track.optString("youtube_id").equals("C1111111111")) { acquiredId=track.getString("id"); acquiredTrack=track; }}
                    if(acquiredId==null) Thread.sleep(200);
                }
                assertNotNull("Collection must produce a real acquired source",acquiredId);
                assertEquals("fixture collection album",acquiredTrack.getString("album"));
                assertEquals(1,acquiredTrack.getInt("track_number"));
                assertEquals(occurrences,web.evaluate(scenario,"JSON.stringify(window.__collection.items.map(i=>i.key))"));
                assertEquals("true",web.evaluate(scenario,"window.__collection.id==='C1111111111' && window.__collection.playing"));
                waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-testid=android-entity-profile] [role=status]')).some(e=>e.textContent==='Downloaded')");
                click(web,scenario,"Play");
                waitFor(web,scenario,"window.__collection?.id==="+JSONObject.quote(acquiredId)+" && window.__collection.playing && window.__collection.items[window.__collection.index].source==='local'");
                assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            }
            click(web,scenario,"Back");
            waitFor(web,scenario,"document.querySelector('[data-testid=android-entity-profile] h1')?.textContent==='fixture collection artist'");
            click(web,scenario,"Back");
            waitFor(web,scenario,"!document.querySelector('[data-testid=android-entity-profile]') && document.querySelector('main').scrollTop===window.__collectionReturnScroll");
            assertEquals(JSONObject.quote("fixture collection"),web.evaluate(scenario,"document.querySelector('[data-testid=android-catalog-search] input').value"));
        } finally {
            try {
                if(connection.cookieHeader(connection.getGeneration())!=null) {
                    var tracks=api(connection,origin,"/api/library").getJSONArray("tracks");
                    for(int i=0;i<tracks.length();i++) {var track=tracks.getJSONObject(i); if(track.optString("youtube_id").equals("C1111111111")) mutate(connection,origin,"/api/library/tracks/"+track.getString("id"),null,"DELETE");}
                    var savedNow=api(connection,origin,"/api/library/saved").getJSONArray("saved");
                    for(int i=0;i<savedNow.length();i++) {
                        var entry=savedNow.getJSONObject(i); boolean existed=false;
                        if(savedBefore!=null) for(int j=0;j<savedBefore.length();j++) if(savedBefore.getJSONObject(j).getJSONArray("keys").toString().equals(entry.getJSONArray("keys").toString())) existed=true;
                        if(!existed && (entry.getJSONArray("keys").toString().contains("deezer:900001") || entry.getJSONArray("keys").toString().contains("yt:C1111111111")))
                            mutate(connection,origin,"/api/library/saved/toggle",new JSONObject().put("entry",entry),"POST");
                    }
                    if(savedBefore!=null) mutate(connection,origin,"/api/library/saved/set",new JSONObject().put("entries",savedBefore).put("saved",true),"POST");
                }
            } finally { connection.clearSession(true); }
        }
    }
}
