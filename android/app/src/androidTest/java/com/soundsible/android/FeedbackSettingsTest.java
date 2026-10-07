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

/** Checks actual bridge requests and OS refusal, not the physical sensation. */
@RunWith(AndroidJUnit4.class)
public class FeedbackSettingsTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario,String condition) throws Exception {
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(45);
        while(System.nanoTime()<until) { if("true".equals(web.evaluate(scenario,condition))) return; Thread.sleep(100); }
        fail(condition+": "+web.evaluate(scenario,"document.body.innerText"));
    }
    private void observe(ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario,"window.__feedbackCalls=0;window.__feedbackAccepted=null;(()=>{const original=Capacitor.nativePromise.bind(Capacitor);Capacitor.nativePromise=(plugin,method,options)=>{if(plugin==='SoundsibleFeedback'&&method==='pulse')window.__feedbackCalls++;return original(plugin,method,options).then(value=>{if(plugin==='SoundsibleFeedback'&&method==='pulse')window.__feedbackAccepted=value.accepted;return value})}})();window.__feedbackTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__feedbackState=s),100)");
        waitFor(scenario,"window.__feedbackState?.ready");
    }
    private void settings(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario,"!!document.querySelector('[data-android-settings]')");
        web.evaluate(scenario,"document.querySelector('[data-android-settings]').click();document.querySelector('[data-android-settings-accessibility]').click()");
        waitFor(scenario,"!!document.querySelector('[data-setting=haptics] [role=switch]')");
    }
    private void transport(ActivityScenario<MainActivity> scenario,boolean playing) throws Exception {
        String button="Array.from(document.querySelectorAll('[data-testid=android-program] button')).find(b=>!b.disabled&&b.textContent==="+JSONObject.quote(playing?"Play":"Pause")+")";
        waitFor(scenario,"!!"+button); assertEquals("true",web.evaluate(scenario,button+".click();true"));
        waitFor(scenario,"window.__feedbackState.playWhenReady==="+playing);
    }
    @Test public void httpFeedback() throws Exception {run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));}
    @Test public void tlsFeedback() throws Exception {run(InstrumentationRegistry.getArguments().getString("tlsOrigin"));}
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context=InstrumentationRegistry.getInstrumentation().getTargetContext();
        var info=context.getPackageManager().getPackageInfo(context.getPackageName(),android.content.pm.PackageManager.GET_PERMISSIONS);
        assertFalse(java.util.Arrays.asList(info.requestedPermissions).contains("android.permission.VIBRATE"));
        var connection=EngineConnection.shared(context); connection.clearSession(true);
        try(var scenario=ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);
            String original=web.evaluate(scenario,"localStorage.getItem('haptics')");
            try {
                web.evaluate(scenario,"localStorage.setItem('lang','en');localStorage.setItem('haptics','on')"); scenario.recreate(); web.awaitReady(scenario);
                web.evaluate(scenario,"document.querySelector('input[type=url]').value="+JSONObject.quote(origin)+";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
                waitFor(scenario,"!!document.querySelector('input[type=password]')");
                web.evaluate(scenario,"document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
                waitFor(scenario,"!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')");
                observe(scenario);
                web.evaluate(scenario,"document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
                waitFor(scenario,"window.__feedbackState.playing&&window.__feedbackCalls===1&&typeof window.__feedbackAccepted==='boolean'");
                transport(scenario,false); waitFor(scenario,"window.__feedbackCalls===2");
                String program=web.evaluate(scenario,"window.__feedbackState.programToken"), keys=web.evaluate(scenario,"JSON.stringify(window.__feedbackState.items.map(i=>i.key))");
                String cookie=connection.cookieHeader(connection.getGeneration()); assertTrue(cookie!=null);
                settings(scenario); web.evaluate(scenario,"document.querySelector('[data-setting=haptics] [role=switch]').click()");
                waitFor(scenario,"localStorage.getItem('haptics')==='off'&&document.querySelector('[data-setting=haptics] [role=switch]').getAttribute('aria-checked')==='false'");
                transport(scenario,true); transport(scenario,false); assertEquals("2",web.evaluate(scenario,"window.__feedbackCalls"));
                scenario.recreate(); waitFor(scenario,"!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')"); observe(scenario);
                settings(scenario); assertEquals("\"false\"",web.evaluate(scenario,"document.querySelector('[data-setting=haptics] [role=switch]').getAttribute('aria-checked')"));
                transport(scenario,true); transport(scenario,false); assertEquals("0",web.evaluate(scenario,"window.__feedbackCalls"));
                web.evaluate(scenario,"document.querySelector('[data-setting=haptics] [role=switch]').click()");
                transport(scenario,true); waitFor(scenario,"window.__feedbackCalls===1&&typeof window.__feedbackAccepted==='boolean'");
                assertEquals(program,web.evaluate(scenario,"window.__feedbackState.programToken")); assertEquals(keys,web.evaluate(scenario,"JSON.stringify(window.__feedbackState.items.map(i=>i.key))"));
                assertTrue(cookie.equals(connection.cookieHeader(connection.getGeneration())));
                scenario.onActivity(activity->activity.getBridge().getWebView().setHapticFeedbackEnabled(false));
                web.evaluate(scenario,"window.__feedbackRefused=null;Capacitor.Plugins.SoundsibleFeedback.pulse({kind:'hold'}).then(r=>window.__feedbackRefused=r.accepted)");
                waitFor(scenario,"window.__feedbackRefused===false");
                web.evaluate(scenario,"window.__feedbackInvalid=null;Capacitor.Plugins.SoundsibleFeedback.pulse({kind:'unknown'}).catch(e=>window.__feedbackInvalid=e.code)");
                waitFor(scenario,"window.__feedbackInvalid==='INVALID_FEEDBACK'");
                assertEquals("false",web.evaluate(scenario,"!!document.querySelector('audio')"));
            } finally {
                scenario.onActivity(activity->activity.getBridge().getWebView().setHapticFeedbackEnabled(true));
                web.evaluate(scenario,original.equals("null")?"localStorage.removeItem('haptics')":"localStorage.setItem('haptics',"+original+")");
            }
        } finally {connection.clearSession(true);}
    }
}
