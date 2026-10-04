package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.TimeUnit;

/** Real queue/pipeline/hash/library; synthetic provider bytes, native preview remains its occurrence. */
@RunWith(AndroidJUnit4.class)
public class AcquisitionTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(50);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String body,String method) throws Exception {
        var builder=new okhttp3.Request.Builder().url(origin+path).header("X-Android-Fixture","isolated");
        String cookie=connection.cookieHeader(connection.getGeneration());if(cookie!=null)builder.header("Cookie",cookie);
        if(!method.equals("GET"))builder.method(method,body==null?null:okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(builder.build()).execute()){assertEquals(path+": "+response.code(),200,response.code());return new JSONObject(response.body().string());}
    }
    private void clickAction(StartupTest web,ActivityScenario<MainActivity> scenario,String label) throws Exception {
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(label)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(label)+").click()");
    }
    @Test public void httpAcquisition() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsAcquisition() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);StartupTest web=new StartupTest();JSONArray savedBefore=null;
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
            savedBefore=api(connection,origin,"/api/library/saved",null,"GET").getJSONArray("saved");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member saved song').click();window.__acquisitionTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__acquisition=s),100)");
            waitFor(web,scenario,"window.__acquisition?.id==='B1111111111' && window.__acquisition.playing && window.__acquisition.ready");clickAction(web,scenario,"Pause");waitFor(web,scenario,"!window.__acquisition.playWhenReady");
            web.evaluate(scenario,"Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,action:'seek',positionMs:20000}))");waitFor(web,scenario,"Math.abs(window.__acquisition.positionMs-20000)<1000");
            String keys=web.evaluate(scenario,"JSON.stringify(window.__acquisition.items.map(i=>i.key))"),token=web.evaluate(scenario,"window.__acquisition.queueToken");
            api(connection,origin,"/__fixture/acquisition","{\"failNext\":1,\"delaySeconds\":3}","POST");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member saved song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");clickAction(web,scenario,"Download");
            web.evaluate(scenario,"document.querySelector('[data-android-downloads]').click()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-downloads] button[aria-label=Retry]')");
            web.evaluate(scenario,"document.querySelector('[data-testid=android-downloads] button[aria-label=Retry]').click()");
            waitFor(web,scenario,"!!document.querySelector('[data-testid=android-downloads] button[aria-label=Cancel]')");
            waitFor(web,scenario,"!document.querySelector('[data-testid=android-downloads] button[aria-label=Cancel]') && !document.querySelector('[data-testid=android-downloads] button[aria-label=Retry]')");
            String acquiredId=null;var tracks=api(connection,origin,"/api/library",null,"GET").getJSONArray("tracks");for(int i=0;i<tracks.length();i++){var row=tracks.getJSONObject(i);if(row.optString("youtube_id").equals("B1111111111"))acquiredId=row.getString("id");}
            assertNotNull("Completed job must have a real acquired library source",acquiredId);assertNotEquals("B1111111111",acquiredId);
            web.evaluate(scenario,"Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Library').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.closest('[data-browse-track-id]')?.getAttribute('data-browse-track-id')==="+JSONObject.quote(acquiredId)+" && b.getAttribute('aria-current')==='true')");
            assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__acquisition.items.map(i=>i.key))"));assertEquals(token,web.evaluate(scenario,"window.__acquisition.queueToken"));assertEquals("true",web.evaluate(scenario,"window.__acquisition.id==='B1111111111' && window.__acquisition.items[0].source==='preview' && !window.__acquisition.playWhenReady && Math.abs(window.__acquisition.positionMs-20000)<1000"));
            api(connection,origin,"/__fixture/acquisition","{\"delaySeconds\":5}","POST");
            web.evaluate(scenario,"document.querySelector('[data-android-discover]').click()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-catalog-search] input[type=search]')");
            web.evaluate(scenario,"const input=document.querySelector('[data-testid=android-catalog-search] input[type=search]');input.value='fixture';input.dispatchEvent(new Event('input',{bubbles:true}))");waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-catalog-search] [data-row-main]')).find(b=>b.textContent==='fixture resolved song')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-catalog-search] [data-row-main]')).find(b=>b.textContent==='fixture resolved song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");clickAction(web,scenario,"Download");
            long queuedUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);boolean queued=false;
            while(!queued){var jobs=api(connection,origin,"/api/downloader/queue/status",null,"GET").getJSONArray("queue");for(int i=0;i<jobs.length();i++)queued |= jobs.getJSONObject(i).optString("video_id").equals("C1111111111");if(!queued){assertTrue("Wait for accepted intake before leaving Search",System.nanoTime()<queuedUntil);Thread.sleep(100);}}
            web.evaluate(scenario,"document.querySelector('[data-android-downloads]').click()");waitFor(web,scenario,"!!document.querySelector('[data-testid=android-downloads] button[aria-label=Cancel]')");
            long activeUntil=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);while(api(connection,origin,"/__fixture/acquisition",null,"GET").getInt("active")==0){assertTrue(System.nanoTime()<activeUntil);Thread.sleep(100);}
            web.evaluate(scenario,"document.querySelector('[data-testid=android-downloads] button[aria-label=Cancel]').click()");waitFor(web,scenario,"!document.querySelector('[data-testid=android-downloads] button[aria-label=Cancel]')");
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);while(api(connection,origin,"/__fixture/acquisition",null,"GET").getInt("active")>0){assertTrue(System.nanoTime()<until);Thread.sleep(100);}Thread.sleep(1000);
            tracks=api(connection,origin,"/api/library",null,"GET").getJSONArray("tracks");for(int i=0;i<tracks.length();i++)assertNotEquals("Cancelled job cannot promote a song", "C1111111111",tracks.getJSONObject(i).optString("youtube_id"));
            assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__acquisition.items.map(i=>i.key))"));assertEquals(token,web.evaluate(scenario,"window.__acquisition.queueToken"));assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Library').click()");
            waitFor(web,scenario,"!!document.querySelector('[data-browse-track-id=\""+acquiredId+"\"] [data-row-main]')");
            web.evaluate(scenario,"document.querySelector('[data-browse-track-id=\""+acquiredId+"\"] [data-row-main]').click()");
            waitFor(web,scenario,"window.__acquisition.id==="+JSONObject.quote(acquiredId)+" && window.__acquisition.ready && window.__acquisition.playing && window.__acquisition.items[window.__acquisition.index].source==='local'");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            web.evaluate(scenario,"Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s,action:'stop'}))");waitFor(web,scenario,"!window.__acquisition.queue.length");
            web.evaluate(scenario,"clearInterval(window.__acquisitionTimer)");
        }finally{
            try{
                if(connection.cookieHeader(connection.getGeneration())!=null){
                    var jobs=api(connection,origin,"/api/downloader/queue/status",null,"GET").getJSONArray("queue");for(int i=0;i<jobs.length();i++){var row=jobs.getJSONObject(i);if(java.util.Set.of("B1111111111","C1111111111").contains(row.optString("video_id")))api(connection,origin,"/api/downloader/queue/"+row.getString("id"),null,"DELETE");}
                    var tracks=api(connection,origin,"/api/library",null,"GET").getJSONArray("tracks");for(int i=0;i<tracks.length();i++){var row=tracks.getJSONObject(i);if(java.util.Set.of("B1111111111","C1111111111").contains(row.optString("youtube_id")))api(connection,origin,"/api/library/tracks/"+row.getString("id"),null,"DELETE");}
                    api(connection,origin,"/__fixture/acquisition","{\"delaySeconds\":2,\"failNext\":0}","POST");
                    if(savedBefore!=null)api(connection,origin,"/api/library/saved/set",new JSONObject().put("entries",savedBefore).put("saved",true).toString(),"POST");
                }
            }finally{connection.clearSession(true);}
        }
    }
}
