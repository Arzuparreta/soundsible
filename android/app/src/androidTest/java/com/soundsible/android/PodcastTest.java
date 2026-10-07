package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.Context;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import android.os.Bundle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@androidx.media3.common.util.UnstableApi
@RunWith(AndroidJUnit4.class)
public class PodcastTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<until) {if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText")+" "+web.evaluate(scenario,"JSON.stringify(window.__pod)"));
    }
    private void observe(StartupTest web,ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario,"window.__podTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__pod=s),100)");
    }
    private void command(StartupTest web,ActivityScenario<MainActivity> scenario,String args) throws Exception {
        web.evaluate(scenario,"window.__podCommand=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__pod,"+args+"}).then(()=>window.__podCommand=true).catch(e=>window.__podError=e.message)");
        waitFor(web,scenario,"window.__podCommand===true");
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String body) throws Exception {
        okhttp3.Request.Builder request=new okhttp3.Request.Builder().url(origin+path);
        String cookie=connection.cookieHeader(connection.getGeneration());if(cookie!=null)request.header("Cookie",cookie);
        if(body!=null)request.post(okhttp3.RequestBody.create(body,okhttp3.MediaType.get("application/json")));
        if(path.startsWith("/__fixture/"))request.header("X-Android-Fixture","isolated");
        try(okhttp3.Response response=connection.getClient().newCall(request.build()).execute()){assertEquals(200,response.code());return new JSONObject(response.body().string());}
    }
    @Test public void httpPodcastResumeAndSeek() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsPodcastResumeAndSeek() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();EngineConnection connection=EngineConnection.shared(context);connection.clearSession(true);
        StartupTest web=new StartupTest();
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('[data-android-podcasts]')");observe(web,scenario);
            web.evaluate(scenario,"document.querySelector('[data-android-podcasts]').click();Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture podcast').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture episode')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture episode').click()");
            waitFor(web,scenario,"window.__pod?.playing && window.__pod.items[0]?.source==='podcast' && window.__pod.seekable");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            command(web,scenario,"action:'pause'");command(web,scenario,"action:'seek',positionMs:120000");
            waitFor(web,scenario,"!window.__pod.playWhenReady && Math.abs(window.__pod.positionMs-120000)<1000");
            web.evaluate(scenario,"document.querySelector('[data-podcast-forward]').click()");
            waitFor(web,scenario,"Math.abs(window.__pod.positionMs-135000)<1000 && !window.__pod.playWhenReady");
            web.evaluate(scenario,"document.querySelector('[data-podcast-back]').click()");waitFor(web,scenario,"Math.abs(window.__pod.positionMs-120000)<1000");
            scenario.recreate();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]') && !document.documentElement.hasAttribute('data-booting')");observe(web,scenario);
            waitFor(web,scenario,"window.__pod?.items[0]?.source==='podcast' && !window.__pod.playWhenReady && Math.abs(window.__pod.positionMs-120000)<1000");
            command(web,scenario,"action:'stop'");waitFor(web,scenario,"window.__pod.items.length===0");
            web.evaluate(scenario,"document.querySelector('[data-android-podcasts]').click();Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture podcast').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture episode')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture episode').click()");
            waitFor(web,scenario,"window.__pod?.playing && window.__pod.positionMs>=119000 && window.__pod.positionMs<125000");
            command(web,scenario,"action:'pause'");
            api(connection,origin,"/__fixture/podcast","{\"peek_status\":503}");
            command(web,scenario,"action:'seek',positionMs:590000");
            waitFor(web,scenario,"window.__pod.errorStatus===503 && window.__pod.errorKind==='server'");
            api(connection,origin,"/__fixture/podcast","{\"peek_status\":0}");
            web.evaluate(scenario,"document.querySelector('[data-program-retry]').click()");
            waitFor(web,scenario,"!window.__pod.error && window.__pod.state===3 && !window.__pod.playWhenReady && window.__pod.positionMs>=589000");
            web.evaluate(scenario,"document.querySelector('[data-podcast-forward]').click()");waitFor(web,scenario,"window.__pod.positionMs>=599000 && !window.__pod.playWhenReady");
            assertEquals("false",web.evaluate(scenario,"JSON.stringify(window.__pod.items).includes('stream_token') || JSON.stringify(window.__pod.items).includes('podcasts/stream')"));
            command(web,scenario,"action:'seek',positionMs:120000");
            api(connection,origin,"/__fixture/podcast","{\"acquire_episode\":true}");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Refresh').click()");
            waitFor(web,scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-music-list-row]')).some(r=>r.textContent.includes('member fixture episode')&&r.textContent.includes('Downloaded'))");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('[data-testid=android-podcasts] [data-row-main]')).find(b=>b.textContent==='member fixture episode').click()");
            waitFor(web,scenario,"window.__pod?.id==='member-podcast-acquired' && window.__pod.playing && window.__pod.positionMs>=119000 && window.__pod.positionMs<125000 && window.__pod.items[0]?.mediaKind==='podcast_episode'");
            JSONObject stats=api(connection,origin,"/api/android-fixture/podcast-stats",null);
            assertTrue(stats.getJSONArray("peek_requests").length()>=3);
            var records=stats.getJSONArray("upstream");for(int i=0;i<records.length();i++)assertFalse(records.getJSONObject(i).getBoolean("cookie_present"));
        } finally { if(!connection.getOrigin().isEmpty() && connection.cookieHeader(connection.getGeneration())!=null)api(connection,origin,"/__fixture/podcast","{\"peek_status\":0}");connection.clearSession(true); }
    }
    @Test public void progressJoinsAcquiredCopiesAndIsolatesAccounts() {
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();PodcastProgressStore store=new PodcastProgressStore(context);
        String enclosure="https://podcasts.fixture.example/progress/"+java.util.UUID.randomUUID();
        Bundle a=new Bundle();a.putBoolean(ProgramQueue.PODCAST,true);a.putString(ProgramQueue.ENCLOSURE,enclosure);a.putString(ProgramQueue.PROFILE,"server|member");a.putString(ProgramQueue.EPISODE,"guid");a.putString(ProgramQueue.FEED,"feed");
        MediaItem streamed=new MediaItem.Builder().setMediaId("streamed-guid").setMediaMetadata(new MediaMetadata.Builder().setExtras(a).build()).build();
        MediaItem acquired=streamed.buildUpon().setMediaId("acquired-id").build();store.save(streamed,45000,60000,false);assertEquals(45000,store.position(acquired));
        Bundle local=new Bundle(a);local.remove(ProgramQueue.ENCLOSURE);MediaItem noUrl=acquired.buildUpon().setMediaMetadata(new MediaMetadata.Builder().setExtras(local).build()).build();assertEquals(45000,store.position(noUrl));
        store.save(noUrl,30000,60000,false);assertEquals(30000,store.position(streamed));
        Bundle b=new Bundle(a);b.putString(ProgramQueue.PROFILE,"server|owner");MediaItem other=streamed.buildUpon().setMediaMetadata(new MediaMetadata.Builder().setExtras(b).build()).build();assertEquals(0,store.position(other));
        store.save(acquired,60000,60000,true);assertEquals(0,store.position(streamed));
        store.save(acquired,60000,-1,false);assertEquals(0,store.position(streamed));
        store.save(acquired,15000,-1,false);assertEquals(15000,store.position(streamed));
    }
}
