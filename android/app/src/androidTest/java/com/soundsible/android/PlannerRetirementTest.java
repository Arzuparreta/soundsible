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

/** A delayed production planner response must never resurrect a privately retired source. */
@RunWith(AndroidJUnit4.class)
public class PlannerRetirementTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail(condition + ": " + web.evaluate(scenario, "JSON.stringify(window.__retirementState)+' '+document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection, String origin, String cookie, String path, String method, JSONObject body) throws Exception {
        var builder = new okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated");
        if (cookie != null) builder.header("Cookie", cookie);
        if (!method.equals("GET")) builder.method(method, body == null ? null : okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(builder.build()).execute()) {
            assertEquals(path + " status", 200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        waitFor(scenario, "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ")");
        web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ").click()");
    }
    private void command(ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario, "window.__retirementDone=false;window.__retirementError=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s," + fields + "})).then(()=>window.__retirementDone=true).catch(e=>window.__retirementError=e.message)");
        waitFor(scenario, "window.__retirementDone || !!window.__retirementError");
        assertEquals(web.evaluate(scenario, "window.__retirementError"), "true", web.evaluate(scenario, "window.__retirementDone"));
    }
    @Test public void httpRadioRetirement() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), "radio"); }
    @Test public void tlsRadioRetirement() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), "radio"); }
    @Test public void httpAutoplayRetirement() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), "autoplay"); }
    @Test public void tlsAutoplayRetirement() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), "autoplay"); }
    private void run(String origin, String mode) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        String cookie = null; Boolean previous = null; String retired = null;
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-testid=android-library]')");
            cookie = connection.cookieHeader(connection.getGeneration()); assertNotNull(cookie);
            previous = api(connection, origin, cookie, "/api/discovery/settings", "GET", null).getBoolean("autoplay_enabled");
            api(connection, origin, null, "/__fixture/radio-seed", "POST", new JSONObject());
            if (mode.equals("autoplay"))
                api(connection, origin, null, "/__fixture/loudness-facts", "POST", new JSONObject().put("album", true));
            web.evaluate(scenario, "window.__retirementTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__retirementState=s),100)");
            waitFor(scenario, "window.__retirementState?.ready");
            command(scenario, "action:'autoplay',enabled:false");
            waitFor(scenario, "window.__retirementState.autoplay?.enabled===false && window.__retirementState.autoplay.settingsPhase==='ready'");
            command(scenario, "action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'}]");
            waitFor(scenario, "window.__retirementState.playing");
            command(scenario, "action:'pause'"); command(scenario, "action:'seek',positionMs:20000");
            waitFor(scenario, "!window.__retirementState.playWhenReady && Math.abs(window.__retirementState.positionMs-20000)<1000");
            String key = web.evaluate(scenario, "window.__retirementState.items[0].key");
            String owner = web.evaluate(scenario, "window.__retirementState.programToken");
            // Seeding does not notify the app: refresh until the rows exist, so the UI steps below
            // cannot spend the delayed plan's window waiting for the list.
            // The library remembers its last tab between cases and the track rows only exist on Songs.
            // A refresh already running ignores another click, so ask again until the rows are there.
            long rowsUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (!"true".equals(web.evaluate(scenario, "!!document.querySelector('[data-browse-track-id^=\"member-radio-\"]')"))) {
                assertTrue("Seeded rows never reached the library list: " + web.evaluate(scenario, "document.body.innerText"), System.nanoTime() < rowsUntil);
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] nav button')).find(b=>b.textContent==='Songs')?.click();Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh')?.click()");
                Thread.sleep(2000);
            }
            int delivered = api(connection, origin, null, "/__fixture/radio-stats", "GET", null).getInt("delivered");
            api(connection, origin, null, "/__fixture/radio-delay", "POST", new JSONObject().put("seconds", 5));
            command(scenario, mode.equals("radio") ? "action:'radio',enabled:true,profile:'balanced'" : "action:'autoplay',enabled:true");
            JSONObject stats; long planSeen = System.nanoTime(); long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            do {
                stats = api(connection, origin, null, "/__fixture/radio-stats", "GET", null);
                if (stats.getInt("pending") > 0) { planSeen = System.nanoTime(); break; }
                assertTrue("Planner must compute a delayed production response", System.nanoTime() < until); Thread.sleep(50);
            } while (true);
            var planned = stats.getJSONArray("delayed_ids");
            for (int index = 0; index < planned.length(); index++) {
                String id = planned.getString(index);
                if (id.startsWith("member-radio-")) { retired = id; break; }
            }
            // Earlier cases may make PCM recordings score ahead of radio clones.
            // Retire a real computed candidate, never impose a recommendation order.
            if (retired == null) for (int index = 0; index < planned.length(); index++) {
                String id = planned.getString(index);
                if (id.equals("member-pcm-soft") || id.equals("member-pcm-loud")) { retired = id; break; }
            }
            assertNotNull("Computed plan must contain a recording owned by this retirement fixture: " + planned, retired);
            String selector = "[data-browse-track-id=" + JSONObject.quote(retired) + "] [data-row-menu]";
            waitFor(scenario, "!!document.querySelector(" + JSONObject.quote(selector) + ")");
            web.evaluate(scenario, "document.querySelector(" + JSONObject.quote(selector) + ").click()");
            click(scenario, "Delete from library");
            JSONObject beforeDelete = api(connection, origin, null, "/__fixture/radio-stats", "GET", null);
            assertTrue("Deletion must occur while the computed plan is still pending: " + beforeDelete + " retired=" + retired
                + " seen " + TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - planSeen) + " ms ago", beforeDelete.getInt("pending") > 0);
            click(scenario, "Delete");
            waitFor(scenario, "!document.querySelector('[data-browse-track-id=" + JSONObject.quote(retired) + "]')");
            var rows = api(connection, origin, cookie, "/api/library", "GET", null).getJSONArray("tracks");
            for (int i = 0; i < rows.length(); i++) assertNotEquals(retired, rows.getJSONObject(i).getString("id"));
            until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            do {
                stats = api(connection, origin, null, "/__fixture/radio-stats", "GET", null);
                if (stats.getInt("delivered") > delivered && stats.getInt("pending") == 0 && stats.getInt("calls") >= 2) break;
                assertTrue("Old response and replacement refill must complete", System.nanoTime() < until); Thread.sleep(50);
            } while (true);
            waitFor(scenario, "window.__retirementState.items.length>1 && window.__retirementState." + mode + ".active && ['ready','degraded','exhausted'].includes(window.__retirementState." + mode + ".phase)");
            assertEquals(key, web.evaluate(scenario, "window.__retirementState.items[0].key"));
            assertEquals(owner, web.evaluate(scenario, "window.__retirementState.programToken"));
            assertEquals("true", web.evaluate(scenario, "!window.__retirementState.playWhenReady && Math.abs(window.__retirementState.positionMs-20000)<1000 && window.__retirementState.items.every(i=>i.source!=='local'||i.id!==" + JSONObject.quote(retired) + ")"));
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
            assertTrue("Retirement must retain its account", cookie.equals(connection.cookieHeader(connection.getGeneration())));
            command(scenario, "action:'stop'");
            web.evaluate(scenario, "clearInterval(window.__retirementTimer)");
        } finally {
            try {
                api(connection, origin, null, "/__fixture/radio-delay", "POST", new JSONObject().put("seconds", 0));
                if (cookie != null && previous != null) api(connection, origin, cookie, "/api/discovery/settings", "PATCH", new JSONObject().put("autoplay_enabled", previous));
                long cleanupUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (api(connection, origin, null, "/__fixture/radio-stats", "GET", null).getInt("pending") > 0) {
                    assertTrue("Fixture delayed response must drain before next case", System.nanoTime() < cleanupUntil); Thread.sleep(50);
                }
                api(connection, origin, null, "/__fixture/radio-seed", "POST", new JSONObject());
                if (retired != null && retired.startsWith("member-pcm-"))
                    api(connection, origin, null, "/__fixture/loudness-facts", "POST", new JSONObject().put("album", true));
            } finally { connection.clearSession(true); }
        }
    }
}
