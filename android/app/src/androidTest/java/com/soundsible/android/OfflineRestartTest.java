package com.soundsible.android;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Host runs this twice, force-stopping the APK between phases. Main suite explicitly excludes it. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public class OfflineRestartTest {
    private void waitFor(StartupTest web,ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(40);
        while(System.nanoTime()<deadline) { if("true".equals(web.evaluate(scenario,condition))) return;Thread.sleep(100); }
        fail(condition+" "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void control(EngineConnection connection,String origin,boolean enabled) throws Exception {
        try(okhttp3.Response response=connection.getClient().newCall(new okhttp3.Request.Builder().url(origin+"/__fixture/connection-failure").header("X-Android-Fixture","isolated").post(okhttp3.RequestBody.create("{\"enabled\":"+enabled+",\"status\":503}",okhttp3.MediaType.get("application/json"))).build()).execute()) {assertEquals(200,response.code());}
    }
    private JSONObject api(EngineConnection connection,String origin,String path,String method,JSONObject body) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path).header("Cookie",connection.cookieHeader(connection.getGeneration()));
        if(path.startsWith("/__fixture/"))request.header("X-Android-Fixture","isolated");
        if(!method.equals("GET"))request.method(method,okhttp3.RequestBody.create(body.toString(),okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(request.build()).execute()){assertEquals(200,response.code());return new JSONObject(response.body().string());}
    }
    @Test public void durableExplicitCopies() throws Exception {
        String phase=InstrumentationRegistry.getArguments().getString("offlinePhase");assertNotNull(phase);
        String origin=InstrumentationRegistry.getArguments().getString("fixtureOrigin");assertNotNull(origin);
        Context context=InstrumentationRegistry.getInstrumentation().getTargetContext();EngineConnection connection=EngineConnection.shared(context);
        StartupTest web=new StartupTest();
        if("prepare".equals(phase)) connection.clearSession(true);
        try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
            if("prepare".equals(phase)) {
                web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
                web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
                waitFor(web,scenario,"!!document.querySelector('input[type=password]')");web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
                waitFor(web,scenario,"!!document.querySelector('[data-testid=android-library]')");
                boolean original=api(connection,origin,"/api/discovery/settings","GET",null).getBoolean("volume_leveling");
                context.getSharedPreferences("offline-restart-test",Context.MODE_PRIVATE).edit().putBoolean("originalLeveling",original).commit();
                api(connection,origin,"/__fixture/loudness-facts","POST",new JSONObject().put("measured",false));
                api(connection,origin,"/api/discovery/settings","PATCH",new JSONObject().put("volume_leveling",true));
                web.evaluate(scenario,"window.__restartTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__restart=s),100)");
                waitFor(web,scenario,"window.__restart?.ready");
                web.evaluate(scenario,"Capacitor.Plugins.SoundsiblePlayback.command({action:'leveling',reload:true,enabled:true,generation:window.__restart.generation})");
                waitFor(web,scenario,"window.__restart?.leveling?.settingsPhase==='ready'&&window.__restart.leveling.enabled===true");
                web.evaluate(scenario,"Capacitor.Plugins.SoundsibleOffline.command({action:'prepare',generation:"+connection.getGeneration()+",tracks:[{id:'member-track',title:'member private song',artist:'member artist',album:'member album'}],playlists:{flight:['member-track','member-track']}})");
                long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
                while(connection.getOffline().local("member-track",connection.getGeneration())==null) {assertTrue(System.nanoTime()<deadline);Thread.sleep(100);}
                control(connection,origin,true);
            } else {
                assertEquals("offline",phase);assertEquals(origin,connection.getOrigin());
                waitFor(web,scenario,"!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
                assertEquals(1,connection.getOffline().state(connection.getGeneration()).getJSONArray("items").length());
                assertNotNull(connection.getOffline().local("member-track",connection.getGeneration()));
                web.evaluate(scenario,"window.__restartTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__restart=s),200);Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song').click()");
                waitFor(web,scenario,"window.__restart?.playing && window.__restart.items[0].offline===true");
                try(var probe=new ProgramPcmTest.Probe(connection.getGeneration())) {
                    String key=new org.json.JSONArray("["+web.evaluate(scenario,"window.__restart.items[0].key")+"]").getString(0);
                    probe.await(key,1893,0);
                }
                web.evaluate(scenario,"document.querySelector('[data-program-close]').click()");
                waitFor(web,scenario,"window.__restart?.items.length===0");
                // Same-length corruption must lose ready status; digest was persisted across process death.
                java.io.File file=connection.getOffline().local("member-track",connection.getGeneration());long modified=file.lastModified();
                try(java.io.RandomAccessFile output=new java.io.RandomAccessFile(file,"rw")) {output.seek(0);output.write(new byte[]{0,0,0,0});}
                assertTrue(file.setLastModified(modified+1000));assertNull(connection.getOffline().local("member-track",connection.getGeneration()));
                assertEquals("error",connection.getOffline().state(connection.getGeneration()).getJSONArray("items").getJSONObject(0).getString("state"));
                control(connection,origin,false);
                connection.clearSession(true);assertEquals(0,connection.getOffline().state(connection.getGeneration()).getJSONArray("items").length());
            }
        } finally { if(!"prepare".equals(phase)) {
            try { if(!connection.getOrigin().isEmpty()) {
                control(connection,origin,false);
                api(connection,origin,"/api/discovery/settings","PATCH",new JSONObject().put("volume_leveling",context.getSharedPreferences("offline-restart-test",Context.MODE_PRIVATE).getBoolean("originalLeveling",true)));
                context.getSharedPreferences("offline-restart-test",Context.MODE_PRIVATE).edit().clear().commit();
            } } finally { connection.clearSession(true); }
        } }
    }
}
