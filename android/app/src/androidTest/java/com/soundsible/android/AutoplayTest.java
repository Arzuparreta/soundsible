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

/** Actual planner and acquired files, with native queue state as authority. */
@RunWith(AndroidJUnit4.class)
public class AutoplayTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
        while(System.nanoTime()<deadline){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"JSON.stringify(window.__radio)")+" "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void observe(StartupTest web, ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario,"window.__radioTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__radio=s),100)");
    }
    private void command(StartupTest web, ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario,"window.__done=false;window.__error=null;Capacitor.Plugins.SoundsiblePlayback.state().then(fresh=>Capacitor.Plugins.SoundsiblePlayback.command({...fresh,"+fields+"})).then(()=>window.__done=true).catch(e=>window.__error=e.message)");
        waitFor(web,scenario,"window.__done===true || !!window.__error");
        assertEquals(web.evaluate(scenario,"window.__error+' '+JSON.stringify(window.__radio)"),"true",web.evaluate(scenario,"window.__done===true"));
    }
    @Test public void httpAutoplay() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsAutoplay() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection=EngineConnection.shared(context);connection.clearSession(true);

        StartupTest web=new StartupTest();
        try(var scenario=ActivityScenario.launch(MainActivity.class)){
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web,scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
        try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/radio-seed").header("X-Android-Fixture","isolated").post(okhttp3.RequestBody.create("{\"failNext\":1}",okhttp3.MediaType.get("application/json"))).build()).execute()){assertEquals(200,response.code());}
            observe(web,scenario);
            waitFor(web,scenario,"window.__radio?.ready===true");
            command(web,scenario,"action:'queue',tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'},{source:'local',id:'member-radio-0',title:'Manual',artist:'member artist'},{source:'local',id:'member-radio-1',title:'Manual two',artist:'member artist'},{source:'local',id:'member-radio-2',title:'Manual three',artist:'member artist'}],index:0");
            waitFor(web,scenario,"window.__radio?.playing && window.__radio.items.length===4");
            command(web,scenario,"action:'pause'");command(web,scenario,"action:'seek',positionMs:60000");
            waitFor(web,scenario,"!window.__radio.playWhenReady && Math.abs(window.__radio.positionMs-60000)<1000");
            String key=web.evaluate(scenario,"window.__radio.items[0].key");
            waitFor(web,scenario,"window.__radio.autoplay?.enabled===false && window.__radio.autoplay.settingsPhase==='ready'");
            assertEquals("4",web.evaluate(scenario,"window.__radio.items.length"));
            web.evaluate(scenario,"document.querySelector('[data-program-menu]').click()");
            waitFor(web,scenario,"!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Autoplay similar music')");
            web.evaluate(scenario,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Autoplay similar music').click()");
            waitFor(web,scenario,"window.__radio.autoplay?.enabled===true && window.__radio.autoplay.settingsPhase==='ready'");
            assertEquals("true",web.evaluate(scenario,"window.__radio.items.length===4 && !window.__radio.autoplay.active"));
            command(web,scenario,"action:'remove',index:3,key:window.__radio.items[3].key");
            waitFor(web,scenario,"window.__radio.autoplay.active && window.__radio.items.length>3");
            assertEquals(key,web.evaluate(scenario,"window.__radio.items[0].key"));
            assertEquals("true",web.evaluate(scenario,"!window.__radio.playWhenReady && window.__radio.items.slice(3).every(i=>i.generatedSource==='autoplay')"));
            command(web,scenario,"action:'append',tracks:[{source:'local',id:'member-track',title:'Another manual occurrence',artist:'member artist'}]");
            waitFor(web,scenario,"window.__radio.items[3]?.title==='Another manual occurrence' && !window.__radio.items[3].generated");
            waitFor(web,scenario,"window.__radio.items.length>5");
            int initialCount=Integer.parseInt(web.evaluate(scenario,"window.__radio.items.length"));
            int callsBefore;
            try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/radio-stats").header("X-Android-Fixture","isolated").build()).execute()){
                assertEquals(200,response.code());callsBefore=new JSONObject(response.body().string()).getInt("calls");
            }
            command(web,scenario,"action:'select',index:5,key:window.__radio.items[5].key");
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
            while(true){
                try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/radio-stats").header("X-Android-Fixture","isolated").build()).execute()){
                    assertEquals(200,response.code());if(new JSONObject(response.body().string()).getInt("calls")>callsBefore)break;
                }
                assertTrue("Autoplay refill did not run in background",System.nanoTime()<deadline);Thread.sleep(100);
            }
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
            waitFor(web,scenario,"window.__radio.items.length>"+initialCount);
            command(web,scenario,"action:'select',index:0,key:window.__radio.items[0].key");command(web,scenario,"action:'pause'");
            command(web,scenario,"action:'autoplay',enabled:false");
            waitFor(web,scenario,"window.__radio.autoplay?.enabled===false && !window.__radio.autoplay.active && window.__radio.items.length===4");
            try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/discovery/settings").header("Cookie",connection.cookieHeader(connection.getGeneration())).build()).execute()){
                assertEquals(200,response.code());assertFalse(new JSONObject(response.body().string()).getBoolean("autoplay_enabled"));
            }
            command(web,scenario,"action:'repeat',mode:1");command(web,scenario,"action:'autoplay',enabled:true");
            waitFor(web,scenario,"window.__radio.autoplay?.enabled===true && window.__radio.autoplay.settingsPhase==='ready'");
            command(web,scenario,"action:'select',index:1,key:window.__radio.items[1].key");
            assertEquals("true",web.evaluate(scenario,"window.__radio.items.length===4 && !window.__radio.autoplay.active"));
            command(web,scenario,"action:'repeat',mode:0");waitFor(web,scenario,"window.__radio.autoplay.active && window.__radio.items.length>4");
            String beforeRadio=web.evaluate(scenario,"window.__radio.queueToken");
            command(web,scenario,"action:'radio',enabled:true,profile:'balanced'");
            waitFor(web,scenario,"window.__radio.radio?.active && !window.__radio.autoplay.active && window.__radio.items.slice(4).every(i=>i.generatedSource!=='autoplay')");
            waitFor(web,scenario,"window.__radio.queueToken!=="+beforeRadio);
            web.evaluate(scenario,"window.__oldCloseRejected=null;Capacitor.Plugins.SoundsiblePlayback.command({generation:"+(connection.getGeneration()-1)+",action:'stop',queueToken:"+beforeRadio+"}).then(()=>window.__oldCloseRejected=false,()=>window.__oldCloseRejected=true)");
            waitFor(web,scenario,"window.__oldCloseRejected===true");
            assertEquals("true",web.evaluate(scenario,"window.__radio.items.length>0 && window.__radio.radio.active"));
            command(web,scenario,"action:'stop',queueToken:"+beforeRadio);waitFor(web,scenario,"window.__radio.items.length===0 && !window.__radio.autoplay.active && !window.__radio.radio.active");
        }finally{
            try {
                String cookie=connection.cookieHeader(connection.getGeneration());
                if(cookie!=null)try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/api/discovery/settings").header("Cookie",cookie).patch(okhttp3.RequestBody.create("{\"autoplay_enabled\":false}",okhttp3.MediaType.get("application/json"))).build()).execute()){assertEquals(200,response.code());}
            }finally{connection.clearSession(true);}
        }
    }
}
