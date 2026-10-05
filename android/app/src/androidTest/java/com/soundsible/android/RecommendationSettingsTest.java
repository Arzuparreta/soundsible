package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual account learning, reset cancellation/effect and stable native programme. */
@RunWith(AndroidJUnit4.class)
public class RecommendationSettingsTest {
    private final StartupTest web=new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until) {if("true".equals(web.evaluate(scenario,condition))) return; Thread.sleep(100);}
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection,String origin,String path,JSONObject body,String method) throws Exception {
        var request=new okhttp3.Request.Builder().url(origin+path); String cookie=connection.cookieHeader(connection.getGeneration()); if(cookie!=null)request.header("Cookie",cookie);
        if(path.startsWith("/__fixture/"))request.header("X-Android-Fixture","isolated");
        if(!method.equals("GET"))request.method(method,okhttp3.RequestBody.create(body.toString(),okhttp3.MediaType.get("application/json")));
        try(var response=connection.getClient().newCall(request.build()).execute()){assertEquals(path,200,response.code());return new JSONObject(response.body().string());}
    }
    private JSONObject state(EngineConnection connection,String origin,String account) throws Exception {return api(connection,origin,"/__fixture/discovery-state",new JSONObject().put("account",account),"POST");}
    private int resets(JSONObject value) throws Exception {int n=0;var rows=value.getJSONArray("requests");for(int i=0;i<rows.length();i++)if(rows.getJSONObject(i).getString("method").equals("DELETE"))n++;return n;}
    private void click(ActivityScenario<MainActivity> scenario,String label) throws Exception {
        String button="Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length>0&&!b.disabled&&(b.textContent.trim()==="+JSONObject.quote(label)+"||b.getAttribute('aria-label')==="+JSONObject.quote(label)+"))";
        waitFor(scenario,"!!"+button); assertEquals("true",web.evaluate(scenario,button+".click();true"));
    }
    private void open(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario,"!!document.querySelector('[data-android-settings]')");
        web.evaluate(scenario,"document.querySelector('[data-android-settings]').click();document.querySelector('[data-android-settings-recommendations]').click()");
        waitFor(scenario,"!!document.querySelector('[data-setting=learn-activity] [role=switch]')&&!document.querySelector('[data-testid=android-recommendation-settings]').getAttribute('aria-busy').includes('true')");
    }
    @Test public void httpRecommendationSettings() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsRecommendationSettings() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);var connection=EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());connection.clearSession(true);
        boolean original=true;
        try(var scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);web.evaluate(scenario,"localStorage.setItem('lang','en')");scenario.recreate();web.awaitReady(scenario);
            web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario,"!!document.querySelector('input[type=password]')");
            web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario,"!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')");
            original=api(connection,origin,"/api/discovery/settings",null,"GET").getBoolean("learning_enabled");assertTrue(original);
            for(String account:new String[]{"member","owner"})assertTrue(api(connection,origin,"/__fixture/discovery-seed",new JSONObject().put("account",account),"POST").getBoolean("recorded"));
            JSONObject seeded=state(connection,origin,"member"), owner=state(connection,origin,"owner");assertTrue(seeded.getInt("signals")>0);assertTrue(owner.getInt("signals")>0);
            web.evaluate(scenario,"window.__recommendationTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__recommendation=s),100);document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
            waitFor(scenario,"window.__recommendation?.playing");click(scenario,"Pause");waitFor(scenario,"!window.__recommendation.playWhenReady");
            String program=web.evaluate(scenario,"window.__recommendation.programToken"),keys=web.evaluate(scenario,"JSON.stringify(window.__recommendation.items.map(i=>i.key))"),cookie=connection.cookieHeader(connection.getGeneration());
            open(scenario);web.evaluate(scenario,"document.querySelector('[data-setting=learn-activity] [role=switch]').click()");
            waitFor(scenario,"document.querySelector('[data-setting=learn-activity] [role=switch]').getAttribute('aria-checked')==='false'&&!document.querySelector('[data-testid=android-recommendation-settings]').getAttribute('aria-busy').includes('true')");
            assertFalse(api(connection,origin,"/api/discovery/settings",null,"GET").getBoolean("learning_enabled"));
            assertTrue(state(connection,origin,"owner").getJSONObject("settings").getBoolean("learning_enabled"));
            assertFalse(api(connection,origin,"/api/discovery/events",new JSONObject().put("event","music_saved_to_library").put("payload",new JSONObject().put("title","fixture disabled activity").put("artist","fixture learning artist")),"POST").getBoolean("recorded"));
            int before=resets(state(connection,origin,"member"));click(scenario,"Reset recommendation learning");waitFor(scenario,"!!document.querySelector('[role=dialog]')");click(scenario,"Cancel");waitFor(scenario,"!document.querySelector('[role=dialog]')");assertEquals(before,resets(state(connection,origin,"member")));assertEquals(seeded.getInt("signals"),state(connection,origin,"member").getInt("signals"));
            click(scenario,"Reset recommendation learning");waitFor(scenario,"!!document.querySelector('[role=dialog]')");click(scenario,"Reset recommendation learning");
            waitFor(scenario,"Array.from(document.querySelectorAll('[data-testid=android-recommendation-settings] [role=status]')).some(e=>e.textContent.includes('reset'))");
            JSONObject cleared=state(connection,origin,"member");assertEquals(before+1,resets(cleared));assertEquals(0,cleared.getInt("signals"));assertEquals(0,cleared.getInt("events"));assertEquals(owner.getInt("signals"),state(connection,origin,"owner").getInt("signals"));
            assertEquals(program,web.evaluate(scenario,"window.__recommendation.programToken"));assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__recommendation.items.map(i=>i.key))"));assertTrue(cookie!=null&&cookie.equals(connection.cookieHeader(connection.getGeneration())));
            scenario.recreate();waitFor(scenario,"!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')");open(scenario);
            assertEquals("\"false\"",web.evaluate(scenario,"document.querySelector('[data-setting=learn-activity] [role=switch]').getAttribute('aria-checked')"));
            api(connection,origin,"/__fixture/connection-failure",new JSONObject().put("enabled",true).put("status",503),"POST");
            web.evaluate(scenario,"document.querySelector('[data-android-settings-account]').click();document.querySelector('[data-android-settings-recommendations]').click()");
            waitFor(scenario,"Array.from(document.querySelectorAll('[data-testid=android-recommendation-settings] [role=status]')).some(e=>e.textContent.includes("+JSONObject.quote("Couldn't reach your station")+"))&&!document.querySelector('[data-setting=learn-activity] [role=switch]')");
            api(connection,origin,"/__fixture/connection-failure",new JSONObject().put("enabled",false),"POST");click(scenario,"Retry");
            waitFor(scenario,"document.querySelector('[data-setting=learn-activity] [role=switch]')?.getAttribute('aria-checked')==='false'&&!document.querySelector('[data-testid=android-recommendation-settings] [role=alert]')");
            assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
        } finally {try {api(connection,origin,"/__fixture/connection-failure",new JSONObject().put("enabled",false),"POST");if(connection.cookieHeader(connection.getGeneration())!=null)api(connection,origin,"/api/discovery/settings",new JSONObject().put("learning_enabled",original),"PATCH");}finally{connection.clearSession(true);}}
    }
}
