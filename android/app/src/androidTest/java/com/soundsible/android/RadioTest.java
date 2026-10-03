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
public class RadioTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
        while(System.nanoTime()<deadline){if("true".equals(web.evaluate(scenario,condition)))return;Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"JSON.stringify(window.__radio)")+" "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void observe(StartupTest web, ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario,"window.__radioTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__radio=s),100)");
    }
    private void command(StartupTest web, ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario,"window.__done=false;Capacitor.Plugins.SoundsiblePlayback.command({...window.__radio,"+fields+"}).then(()=>window.__done=true).catch(e=>window.__error=e.message)");
        waitFor(web,scenario,"window.__done===true");
    }
    @Test public void httpRadio() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsRadio() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
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
            command(web,scenario,"action:'queue',tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'},{source:'local',id:'member-radio-0',title:'Manual',artist:'member artist'}],index:0");
            waitFor(web,scenario,"window.__radio?.playing && window.__radio.items.length===2");
            command(web,scenario,"action:'pause'");command(web,scenario,"action:'seek',positionMs:60000");
            waitFor(web,scenario,"!window.__radio.playWhenReady && Math.abs(window.__radio.positionMs-60000)<1000");
            String key=web.evaluate(scenario,"window.__radio.items[0].key");
            command(web,scenario,"action:'radio',enabled:true,profile:'balanced'");
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
            long backgroundDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(20);
            while(true){
                try(var response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/radio-stats").header("X-Android-Fixture","isolated").build()).execute()){
                    assertEquals(200,response.code());if(new JSONObject(response.body().string()).getInt("calls")>=2)break;
                }
                assertTrue("Service retry did not run while Activity stopped",System.nanoTime()<backgroundDeadline);Thread.sleep(100);
            }
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
            waitFor(web,scenario,"window.__radio.radio?.active && window.__radio.items.length>2");
            assertEquals(key,web.evaluate(scenario,"window.__radio.items[0].key"));
            assertEquals("true",web.evaluate(scenario,"!window.__radio.playWhenReady && Math.abs(window.__radio.positionMs-60000)<1000 && window.__radio.items[1].id==='member-radio-0' && new Set(window.__radio.items.map(i=>i.id)).size===window.__radio.items.length"));
            command(web,scenario,"action:'append',tracks:[{source:'local',id:'member-track',title:'Another manual occurrence',artist:'member artist'}]");
            waitFor(web,scenario,"window.__radio.items[2]?.title==='Another manual occurrence' && !window.__radio.items[2]?.generated");
            scenario.recreate();waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]') && !document.documentElement.hasAttribute('data-booting')");observe(web,scenario);
            waitFor(web,scenario,"window.__radio?.radio?.active && window.__radio.items.length>2");
            command(web,scenario,"action:'radio',enabled:false,profile:'balanced'");
            waitFor(web,scenario,"!window.__radio.radio?.active && window.__radio.items.length===3");
            assertEquals(key,web.evaluate(scenario,"window.__radio.items[0].key"));
            command(web,scenario,"action:'stop'");waitFor(web,scenario,"window.__radio.items.length===0");
        }finally{connection.clearSession(true);}
    }
}
