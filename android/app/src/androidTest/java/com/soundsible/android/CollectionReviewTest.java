package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Core review/skip/cancel/retry, including acquisition without a prior resolution. */
@RunWith(AndroidJUnit4.class)
public class CollectionReviewTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until) { if("true".equals(web.evaluate(scenario,condition))) return; Thread.sleep(100); }
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,JSONObject body,String method) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration()); if(cookie!=null) request.header("Cookie",cookie);
        if(path.startsWith("/__fixture/")) request.header("X-Android-Fixture","isolated");
        if(!method.equals("GET")) request.method(method,body==null?null:okhttp3.RequestBody.create(body.toString(),okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(request.build()).execute()) { assertEquals(path,200,response.code()); return new JSONObject(response.body().string()); }
    }
    private void click(StartupTest web,ActivityScenario<MainActivity> scenario,String label) throws Exception {
        String find="Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length>0 && !b.disabled && (b.textContent.trim()==="+JSONObject.quote(label)+" || b.getAttribute('aria-label')==="+JSONObject.quote(label)+"))";
        waitFor(web,scenario,"!!"+find); assertEquals("true",web.evaluate(scenario,find+".click();true"));
    }
    private JSONObject job(EngineConnection connection,String origin,String album) throws Exception {
        return api(connection,origin,"/api/catalog/album/download?deezer_id="+album,null,"GET").getJSONObject("job");
    }
    private void awaitState(EngineConnection connection,String origin,String album,String expected) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(!job(connection,origin,album).getString("state").equals(expected)) { assertTrue("Collection did not reach "+expected,System.nanoTime()<until); Thread.sleep(200); }
    }
    @Test public void httpReviewChoice() throws Exception {run(false,"choose");}
    @Test public void tlsReviewChoice() throws Exception {run(true,"choose");}
    @Test public void httpExplicitSkip() throws Exception {run(false,"skip");}
    @Test public void tlsExplicitSkip() throws Exception {run(true,"skip");}
    @Test public void httpRetryAcquisition() throws Exception {run(false,"retry");}
    @Test public void tlsRetryAcquisition() throws Exception {run(true,"retry");}
    @Test public void httpCancelResolution() throws Exception {run(false,"cancel");}
    @Test public void tlsCancelResolution() throws Exception {run(true,"cancel");}
    private void run(boolean tls,String action) throws Exception {
        String origin=InstrumentationRegistry.getArguments().getString(tls?"tlsOrigin":"fixtureOrigin"); assumeNotNull(origin);
        String album=java.util.Map.of("choose","920002","skip","920003","retry","920004","cancel","920005").get(action);
        String video=java.util.Map.of("choose","D1111111111","skip","B1111111111","retry","E1111111111","cancel","A1111111111").get(action);
        var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext()); connection.clearSession(true);
        StartupTest web=new StartupTest(); JSONArray savedBefore=null;
        try(var scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario,"localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
            savedBefore=api(connection,origin,"/api/library/saved",null,"GET").getJSONArray("saved");
            web.evaluate(scenario,"window.__reviewTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__review=s),100);Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song').click()");
            waitFor(web,scenario,"window.__review?.playing && window.__review.ready");
            String originalId=web.evaluate(scenario,"window.__review.id"), originalKeys=web.evaluate(scenario,"JSON.stringify(window.__review.items.map(i=>i.key))");
            web.evaluate(scenario,"document.querySelector('[data-android-discover]').click();document.querySelector('[data-testid=android-catalog-search] input').value="+JSONObject.quote("fixture review "+action)+";document.querySelector('[data-testid=android-catalog-search] input').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==="+JSONObject.quote("fixture review album "+action)+")");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==="+JSONObject.quote("fixture review album "+action)+").click()");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-entity-profile] h1') && !!Array.from(document.querySelectorAll('[data-testid=android-entity-profile] [data-row-main]')).find(b=>b.textContent==="+JSONObject.quote("fixture review song "+action)+")");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-entity-profile] header button[aria-label]').click()"); click(web,scenario,"Download the album");
            waitFor(web,scenario,"!!document.querySelector('[data-android-collection-progress]')");
            web.evaluate(scenario,"document.querySelector('[data-android-collection-progress]').click()");
            if(action.equals("cancel")) {
                String durableId=job(connection,origin,album).getString("id");
                click(web,scenario,"Stop the download");
                long cancelledUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
                while(!api(connection,origin,"/api/migration/jobs/"+durableId,null,"GET").getJSONObject("job").getString("state").equals("cancelled")) { assertTrue(System.nanoTime()<cancelledUntil); Thread.sleep(100); }
                // The collection status endpoint hides the cancelled job.
                waitFor(web,scenario,"!Array.from(document.querySelectorAll('[role=dialog] button')).some(b=>b.textContent.trim()==='Stop the download')");
            } else {
                awaitState(connection,origin,album,"needs_review");
                waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='Skip')");
                if(action.equals("skip")) { click(web,scenario,"Skip"); awaitState(connection,origin,album,"completed"); assertEquals(1,job(connection,origin,album).getJSONObject("selected_counts").getInt("skipped")); }
                else {
                    if(action.equals("retry")) api(connection,origin,"/__fixture/acquisition",new JSONObject().put("failNext",1).put("delaySeconds",2),"POST");
                    String candidate="Array.from(document.querySelectorAll('[role=dialog] button[data-pressable]')).find(b=>b.getClientRects().length>0 && !b.disabled && b.textContent.includes("+JSONObject.quote("fixture review song "+action+" (Live)")+"))";
                    waitFor(web,scenario,"!!"+candidate); assertEquals("true",web.evaluate(scenario,candidate+".click();true"));
                    if(action.equals("retry")) { awaitState(connection,origin,album,"partial"); assertEquals(1,job(connection,origin,album).getJSONObject("selected_counts").getInt("failed")); click(web,scenario,"Try again"); }
                    awaitState(connection,origin,album,"completed");
                    var tracks=api(connection,origin,"/api/library",null,"GET").getJSONArray("tracks"); JSONObject acquired=null;
                    for(int i=0;i<tracks.length();i++) if(tracks.getJSONObject(i).optString("youtube_id").equals(video)) acquired=tracks.getJSONObject(i);
                    assertNotNull(acquired); assertEquals("fixture review album "+action,acquired.getString("album"));
                    assertEquals(originalId,web.evaluate(scenario,"window.__review.id")); assertEquals(originalKeys,web.evaluate(scenario,"JSON.stringify(window.__review.items.map(i=>i.key))"));
                    // Dismiss the sheet, then play the confirmed acquired source.
                    web.evaluate(scenario,"document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
                    waitFor(web,scenario,"!document.querySelector('[role=dialog]') && Array.from(document.querySelectorAll('[data-testid=android-entity-profile] [role=status]')).some(e=>e.textContent==='Downloaded')");
                    click(web,scenario,"Play");
                    waitFor(web,scenario,"window.__review?.id==="+JSONObject.quote(acquired.getString("id"))+" && window.__review.playing && window.__review.items[window.__review.index].source==='local'");
                }
            }
            if(action.equals("skip") || action.equals("cancel")) { assertEquals(originalId,web.evaluate(scenario,"window.__review.id")); assertEquals(originalKeys,web.evaluate(scenario,"JSON.stringify(window.__review.items.map(i=>i.key))")); }
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        } finally {
            try {
                if(connection.cookieHeader(connection.getGeneration())!=null) {
                    var tracks=api(connection,origin,"/api/library",null,"GET").getJSONArray("tracks");
                    if(action.equals("choose") || action.equals("retry")) for(int i=0;i<tracks.length();i++) {var track=tracks.getJSONObject(i); if(track.optString("youtube_id").equals(video)) api(connection,origin,"/api/library/tracks/"+track.getString("id"),null,"DELETE");}
                    var saved=api(connection,origin,"/api/library/saved",null,"GET").getJSONArray("saved");
                    for(int i=0;i<saved.length();i++) {var entry=saved.getJSONObject(i); if(entry.getJSONArray("keys").toString().contains("deezer:"+(Integer.parseInt(album)+1000))) api(connection,origin,"/api/library/saved/toggle",new JSONObject().put("entry",entry),"POST");}
                    if(savedBefore!=null) api(connection,origin,"/api/library/saved/set",new JSONObject().put("entries",savedBefore).put("saved",true),"POST");
                    api(connection,origin,"/__fixture/acquisition",new JSONObject().put("failNext",0).put("delaySeconds",2),"POST");
                }
            } finally { connection.clearSession(true); }
        }
    }
}
