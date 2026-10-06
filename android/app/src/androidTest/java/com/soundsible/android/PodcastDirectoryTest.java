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

/** Real directory -> feed -> follow -> durable acquire/retry -> local native episode. */
@RunWith(AndroidJUnit4.class)
public class PodcastDirectoryTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
        while(System.nanoTime()<until){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText")+" "+web.evaluate(scenario,"JSON.stringify(window.__directory)"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String body) throws Exception {
        okhttp3.Request.Builder request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration());if(cookie!=null)request.header("Cookie",cookie);
        if(body!=null)request.post(okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json")));
        if(path.startsWith("/__fixture/"))request.header("X-Android-Fixture","isolated");
        try(okhttp3.Response response=connection.getClient().newCall(request.build()).execute()){assertEquals(response.body()==null?"":response.peekBody(1000).string(),200,response.code());return new JSONObject(response.body().string());}
    }
    private boolean subscribed(EngineConnection connection,String origin) throws Exception {
        var subscriptions=api(connection,origin,"/api/library",null).getJSONArray("podcast_subscriptions");
        for(int i=0;i<subscriptions.length();i++)if(subscriptions.getJSONObject(i).optString("rss_url").endsWith("/directory/feed.xml"))return true;
        return false;
    }
    private void awaitSubscribed(EngineConnection connection,String origin,boolean expected) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
        while(subscribed(connection,origin)!=expected){assertTrue(System.nanoTime()<until);Thread.sleep(100);}
    }
    private void menu(StartupTest web,ActivityScenario<MainActivity> scenario,String selector,String action) throws Exception {
        web.evaluate(scenario,"document.querySelector("+JSONObject.quote(selector)+").click()");
        waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+")");
        web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==="+JSONObject.quote(action)+").click()");
    }
    @Test public void httpDirectoryFollowAndAcquire() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsDirectoryFollowAndAcquire() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();EngineConnection connection=EngineConnection.shared(context);connection.clearSession(true);
        StartupTest web=new StartupTest();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('[data-android-podcasts]')");
            web.evaluate(scenario,"window.__directoryTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__directory=s),100);document.querySelector('[data-android-podcasts]').click();document.querySelector('[data-testid=android-podcast-directory] input').value='fixture';document.querySelector('[data-testid=android-podcast-directory] input').dispatchEvent(new Event('input',{bubbles:true}))");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-podcast-directory] [data-row-main]')).find(b=>b.textContent==='fixture directory podcast')");web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcast-directory] [data-row-main]')).find(b=>b.textContent==='fixture directory podcast').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='fixture directory episode')");
            assertFalse(subscribed(connection,origin));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='fixture directory episode').click()");waitFor(web,scenario,"window.__directory?.playing && window.__directory.id==='directory-episode-guid'");
            web.evaluate(scenario,"Capacitor.Plugins.SoundsiblePlayback.command({...window.__directory,action:'pause'}).then(()=>Capacitor.Plugins.SoundsiblePlayback.command({...window.__directory,action:'seek',positionMs:60000}))");waitFor(web,scenario,"!window.__directory.playWhenReady && Math.abs(window.__directory.positionMs-60000)<1000");
            menu(web,scenario,"[data-podcast-show-menu]","Subscribe");
            awaitSubscribed(connection,origin,true);
            waitFor(web,scenario,"document.querySelector('[data-podcast-show-menu]').disabled===false");
            assertTrue(subscribed(connection,origin));
            api(connection,origin,"/__fixture/podcast","{\"enclosure_status\":503}");
            menu(web,scenario,"[data-testid=android-podcasts] [data-row-menu]","Download episode");
            waitFor(web,scenario,"document.querySelector('[data-testid=android-podcasts]').innerText.includes('Could not load')");
            api(connection,origin,"/__fixture/podcast","{\"enclosure_status\":0}");
            menu(web,scenario,"[data-testid=android-podcasts] [data-row-menu]","Retry");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-music-list-row]')).some(r=>r.textContent.includes('fixture directory episode')&&r.textContent.includes('Downloaded'))");
            var tracks=api(connection,origin,"/api/library",null).getJSONArray("tracks");JSONObject acquired=null;
            for(int i=0;i<tracks.length();i++)if(tracks.getJSONObject(i).optString("podcast_episode_guid").equals("directory-episode-guid"))acquired=tracks.getJSONObject(i);
            assertNotNull(acquired);String id=acquired.getString("id");assertEquals("podcast_episode",acquired.getString("media_kind"));
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='fixture directory episode').click()");
            waitFor(web,scenario,"window.__directory?.id==="+JSONObject.quote(id)+" && window.__directory.playing && window.__directory.items[0]?.source==='local' && window.__directory.positionMs>=59000 && window.__directory.positionMs<65000");
            menu(web,scenario,"[data-podcast-show-menu]","Unfollow");
            awaitSubscribed(connection,origin,false);
            waitFor(web,scenario,"!document.querySelector('[data-podcast-show-menu]').disabled");
            assertFalse(subscribed(connection,origin));
            assertTrue(api(connection,origin,"/api/library",null).getJSONArray("tracks").toString().contains(id));
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        } finally {if(!connection.getOrigin().isEmpty() && connection.cookieHeader(connection.getGeneration())!=null)api(connection,origin,"/__fixture/podcast","{\"enclosure_status\":0}");connection.clearSession(true);}
    }
}
