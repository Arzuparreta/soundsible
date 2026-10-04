package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.core.view.WindowCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual shared controls, native system-bar contrast, activity and offline persistence. */
@RunWith(AndroidJUnit4.class)
public class AppearanceSettingsTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail(condition + ": " + web.evaluate(scenario, "document.body.innerText"));
    }
    private void observe(ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario, "window.__appearanceTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__appearanceState=s),100)");
        waitFor(scenario, "window.__appearanceState?.ready");
    }
    private void command(ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario, "window.__appearanceDone=false;window.__appearanceError=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s," + fields + "})).then(()=>window.__appearanceDone=true).catch(e=>window.__appearanceError=e.message)");
        waitFor(scenario, "window.__appearanceDone || !!window.__appearanceError");
        assertEquals("true", web.evaluate(scenario, "window.__appearanceDone"));
    }
    private void open(ActivityScenario<MainActivity> scenario, String section) throws Exception {
        waitFor(scenario, "!!document.querySelector('[data-android-settings]')");
        web.evaluate(scenario, "document.querySelector('[data-android-settings]').click()");
        waitFor(scenario, "!!document.querySelector('[data-android-settings-" + section + "]')");
        web.evaluate(scenario, "document.querySelector('[data-android-settings-" + section + "]').click()");
    }
    private void bars(ActivityScenario<MainActivity> scenario, boolean light) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        var matched = new AtomicBoolean();
        int expectedBackground = android.graphics.Color.parseColor(new org.json.JSONArray("[" + web.evaluate(scenario, "document.querySelector('meta[name=theme-color]').content") + "]").getString(0));
        while (System.nanoTime() < until) {
            scenario.onActivity(activity -> {
                var controller = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
                var background = activity.getWindow().getDecorView().getBackground();
                matched.set(controller.isAppearanceLightStatusBars() == light && controller.isAppearanceLightNavigationBars() == light
                    && background instanceof android.graphics.drawable.ColorDrawable && ((android.graphics.drawable.ColorDrawable) background).getColor() == expectedBackground);
            });
            if (matched.get()) return;
            Thread.sleep(100);
        }
        fail("Native bars and window background must follow the selected palette");
    }
    private void theme(ActivityScenario<MainActivity> scenario, String theme) throws Exception {
        waitFor(scenario, "!!document.querySelector('[data-setting=theme] input[value=" + theme + "]')");
        web.evaluate(scenario, "document.querySelector('[data-setting=theme] input[value=" + theme + "]').click()");
        String resolved = theme.equals("system") ? web.evaluate(scenario, "matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'") : JSONObject.quote(theme);
        waitFor(scenario, "document.documentElement.dataset.theme===" + resolved);
        bars(scenario, resolved.equals("\"light\""));
    }
    private String shell(String command) throws Exception {
        try (var descriptor = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command);
             var input = new java.io.FileInputStream(descriptor.getFileDescriptor())) {
            var bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[1024]; int count;
            while ((count = input.read(buffer)) >= 0) bytes.write(buffer, 0, count);
            return new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.UTF_8).trim();
        }
    }
    private void control(EngineConnection connection, String origin, boolean enabled) throws Exception {
        try (var response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/__fixture/connection-failure").header("X-Android-Fixture", "isolated")
            .post(okhttp3.RequestBody.create("{\"enabled\":" + enabled + ",\"status\":503}", okhttp3.MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    @Test public void httpAppearance() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsAppearance() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        String originalNight = shell("cmd uimode night");
        String restoreNight = originalNight.contains("yes") ? "yes" : originalNight.contains("no") ? "no" : originalNight.contains("custom") ? "custom" : "auto";
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);
            web.evaluate(scenario, "localStorage.setItem('lang','en');localStorage.setItem('theme','system');localStorage.removeItem('soundsible:interface-size');localStorage.removeItem('soundsible:high-contrast')");
            scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[autocomplete=username]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-menu]')");
            String cookie = connection.cookieHeader(connection.getGeneration()); assertTrue(cookie != null);
            web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-menu]').click()");
            waitFor(scenario, "!!Array.from((document.querySelector('[role=menu]')||document.querySelector('[role=dialog]')||document).querySelectorAll('button')).find(b=>b.textContent.includes('Available offline'))");
            web.evaluate(scenario, "Array.from((document.querySelector('[role=menu]')||document.querySelector('[role=dialog]')||document).querySelectorAll('button')).find(b=>b.textContent.includes('Available offline')).click()");
            var store = OfflineStore.shared(context); long generation = connection.getGeneration();
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (store.local("member-track", generation) == null) { assertTrue("Private fixture copy becomes ready", System.nanoTime() < until); Thread.sleep(100); }
            observe(scenario);
            command(scenario, "action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'}]");
            waitFor(scenario, "window.__appearanceState.playing"); command(scenario, "action:'pause'"); command(scenario, "action:'seek',positionMs:20000");
            waitFor(scenario, "!window.__appearanceState.playWhenReady&&Math.abs(window.__appearanceState.positionMs-20000)<1000");
            String key = web.evaluate(scenario, "window.__appearanceState.items[0].key"), program = web.evaluate(scenario, "window.__appearanceState.programToken");
            open(scenario, "appearance");
            for (String palette : new String[]{"light", "dark", "slate", "pure-black", "forest-green", "system"}) theme(scenario, palette);
            shell("cmd uimode night no");
            waitFor(scenario, "!matchMedia('(prefers-color-scheme: dark)').matches");
            waitFor(scenario, "document.documentElement.dataset.theme==='light'"); bars(scenario, true);
            shell("cmd uimode night yes");
            waitFor(scenario, "matchMedia('(prefers-color-scheme: dark)').matches&&document.documentElement.dataset.theme==='dark'"); bars(scenario, false);
            theme(scenario, "slate"); shell("cmd uimode night no");
            waitFor(scenario, "!matchMedia('(prefers-color-scheme: dark)').matches");
            assertEquals("\"slate\"", web.evaluate(scenario, "document.documentElement.dataset.theme")); bars(scenario, false);
            theme(scenario, "light");
            web.evaluate(scenario, "(()=>{const input=document.querySelector('[data-setting=language] select');input.value='es';input.dispatchEvent(new Event('change',{bubbles:true}))})()");
            waitFor(scenario, "document.documentElement.lang==='es'&&document.querySelector('[data-android-settings-appearance]').textContent==='Apariencia'");
            open(scenario, "accessibility");
            web.evaluate(scenario, "(()=>{const input=document.querySelector('#interface-size');input.value='2';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-setting=high-contrast] input').click()})()");
            waitFor(scenario, "document.documentElement.dataset.interfaceSize==='large'&&document.documentElement.dataset.highContrast==='true'");
            assertEquals("true", web.evaluate(scenario, "document.documentElement.scrollWidth<=innerWidth+1&&Array.from(document.querySelectorAll('[data-testid=android-settings] nav button')).every(b=>b.getBoundingClientRect().height>=44&&b.getBoundingClientRect().right<=innerWidth+1)"));
            assertEquals(key, web.evaluate(scenario, "window.__appearanceState.items[0].key")); assertEquals(program, web.evaluate(scenario, "window.__appearanceState.programToken"));
            assertEquals("false", web.evaluate(scenario, "window.__appearanceState.playWhenReady"));
            assertTrue(cookie.equals(connection.cookieHeader(generation))); assertNotNull(store.local("member-track", generation));
            scenario.recreate(); waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')"); observe(scenario);
            waitFor(scenario, "document.documentElement.lang==='es'&&document.documentElement.dataset.theme==='light'&&document.documentElement.dataset.interfaceSize==='large'&&document.documentElement.dataset.highContrast==='true'");
            bars(scenario, true); assertEquals(key, web.evaluate(scenario, "window.__appearanceState.items[0].key"));
            control(connection, origin, true); scenario.recreate(); waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')"); observe(scenario);
            waitFor(scenario, "!!document.querySelector('[data-android-settings]')");
            open(scenario, "appearance"); theme(scenario, "pure-black");
            assertEquals("\"large\"", web.evaluate(scenario, "document.documentElement.dataset.interfaceSize"));
            assertEquals(program, web.evaluate(scenario, "window.__appearanceState.programToken"));
            assertEquals(key, web.evaluate(scenario, "window.__appearanceState.items[0].key"));
            assertEquals("true", web.evaluate(scenario, "Math.abs(window.__appearanceState.positionMs-20000)<1000"));
            assertTrue(cookie.equals(connection.cookieHeader(generation))); assertNotNull(store.local("member-track", generation));
            assertEquals("false", web.evaluate(scenario, "Array.from(document.querySelectorAll('audio,video')).some(m=>!m.paused)"));
        } finally {
            shell("cmd uimode night " + restoreNight);
            if (!connection.getOrigin().isEmpty()) control(connection, origin, false);
            connection.clearSession(true);
        }
    }
}
