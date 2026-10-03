package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.ComponentName;
import android.content.Context;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Packaged UI and actual engine/progressive cache, backed only by synthetic local upstream bytes. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public class PreviewTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < until) {
            if ("true".equals(web.evaluate(scenario, condition))) return;
            Thread.sleep(100);
        }
        fail(condition + ": " + web.evaluate(scenario, "document.body.innerText") + " snapshot=" + web.evaluate(scenario, "JSON.stringify(window.__preview)"));
    }
    private void control(EngineConnection connection, String origin, String json) throws Exception {
        try (okhttp3.Response response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/__fixture/preview").header("X-Android-Fixture", "isolated")
            .post(okhttp3.RequestBody.create(json, okhttp3.MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    private JSONObject stats(EngineConnection connection, String origin) throws Exception {
        try (okhttp3.Response response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/api/android-fixture/preview-stats").header("Cookie", connection.cookieHeader(connection.getGeneration())).build()).execute()) {
            assertEquals(200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private void observe(StartupTest web, ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario, "window.__previewTimer=setInterval(()=>window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__preview=s),100)");
    }
    private void queue(StartupTest web, ActivityScenario<MainActivity> scenario, long gen, String id) throws Exception {
        web.evaluate(scenario, "window.__preview=null;window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'queue',index:0,tracks:[{source:'preview',id:'" + id + "',title:'preview fixture',artist:'fixture'}]})");
    }
    @Test public void httpSavedPreviews() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void verifiedTlsSavedPreviews() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection connection = EngineConnection.shared(context); connection.clearSession(true);
        StartupTest web = new StartupTest();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web, scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web, scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member saved song' && !b.disabled)");
            control(connection, origin, "{\"slow\":true,\"status\":0,\"clear_stats\":true}");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member saved song').click()"); observe(web, scenario);
            waitFor(web, scenario, "window.__preview?.id==='B1111111111' && window.__preview.state===2 && !window.__preview.playing");
            waitFor(web, scenario, "window.__preview?.id==='B1111111111' && window.__preview?.preview?.preparation?.state==='streamable' && window.__preview.playing");
            assertEquals("true", web.evaluate(scenario, "window.__preview.items.some(t=>t.source==='local') && window.__preview.items.some(t=>t.source==='preview')"));
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio') || !!window.AudioContext && performance.getEntriesByType('resource').some(e=>e.name.includes('authenticated-runtime'))"));
            var future = new AtomicReference<com.google.common.util.concurrent.ListenableFuture<MediaController>>();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> future.set(new MediaController.Builder(context, new SessionToken(context, new ComponentName(context, PlaybackService.class))).buildAsync()));
            MediaController nativeController = future.get().get(10, TimeUnit.SECONDS);
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                assertTrue(nativeController.isPlaying()); assertEquals("B1111111111", nativeController.getCurrentMediaItem().mediaId);
                assertNull(nativeController.getMediaMetadata().artworkUri); nativeController.release();
            });
            String key = new JSONObject("{\"key\":" + web.evaluate(scenario, "window.__preview.items[window.__preview.index].key") + "}").getString("key");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).find(b=>b.textContent==='Pause').click()");
            waitFor(web, scenario, "window.__preview?.playWhenReady===false");
            scenario.recreate(); waitFor(web, scenario, "!document.documentElement.hasAttribute('data-booting') && !!document.querySelector('[data-testid=android-program]')"); observe(web, scenario);
            waitFor(web, scenario, "window.__preview?.items[window.__preview.index]?.key===" + JSONObject.quote(key) + " && !window.__preview.playWhenReady");
            waitFor(web, scenario, "window.__preview?.preview?.preparation?.state==='ready'");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'seek',positionMs:120000})");
            waitFor(web, scenario, "window.__preview?.positionMs===120000 && window.__preview.state===3");
            JSONObject first = stats(connection, origin);
            assertEquals(1, first.getJSONArray("upstream").length());
            assertFalse(first.getJSONArray("upstream").getJSONObject(0).getBoolean("cookie_present"));
            assertEquals("bytes=0-", first.getJSONArray("upstream").getJSONObject(0).getString("range"));
            assertTrue(first.getJSONArray("requests").toString().contains("progressive"));
            long gen = connection.getGeneration();
            // Duplicated preview occurrences retain distinct keys and original indices.
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'queue',index:2,tracks:[{source:'preview',id:'B1111111111',title:'first'},{source:'local',id:'member-track',title:'local'},{source:'preview',id:'B1111111111',title:'second'}]})");
            waitFor(web, scenario, "window.__preview?.index===2 && window.__preview.playing && window.__preview.items.length===3");
            assertEquals("true", web.evaluate(scenario, "window.__preview.items[0].key!==window.__preview.items[2].key"));
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED); Thread.sleep(500); scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
            waitFor(web, scenario, "window.__preview?.playing");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'select',index:1,key:window.__preview.items[1].key,queueToken:window.__preview.queueToken})");
            waitFor(web, scenario, "window.__preview?.id==='member-track' && window.__preview.playing && !window.__preview.preview");
            control(connection, origin, "{\"slow\":false}"); queue(web, scenario, gen, "C1111111111");
            waitFor(web, scenario, "window.__preview?.id==='C1111111111' && window.__preview.playing && window.__preview.durationMs>59000");
            web.evaluate(scenario, "window.__invalid=null;window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'queue',index:0,tracks:[{source:'unknown',id:'member-track'}]}).then(()=>window.__invalid=false,()=>window.__invalid=true)");
            waitFor(web, scenario, "window.__invalid===true && window.__preview.id==='C1111111111'");
            control(connection, origin, "{\"cut\":true}"); queue(web, scenario, gen, "B1111111111");
            waitFor(web, scenario, "window.__preview?.errorKind==='connection' && window.__preview.items.length===1");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'pause'})");
            control(connection, origin, "{\"cut\":false}");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'retry',index:0,key:window.__preview.items[0].key,queueToken:window.__preview.queueToken})");
            waitFor(web, scenario, "window.__preview?.state===3 && !window.__preview.playWhenReady && !window.__preview.error");
            control(connection, origin, "{\"status\":503,\"failures\":2,\"retry_after\":\"1\"}"); queue(web, scenario, gen, "B1111111111");
            waitFor(web, scenario, "window.__preview?.preview?.retryPending===true");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'pause'})");
            waitFor(web, scenario, "window.__preview?.preview?.retryAttempt===2 && window.__preview.state===3 && !window.__preview.playWhenReady && !window.__preview.playing");
            assertEquals("true", web.evaluate(scenario, "window.__preview.items.length===1 && window.__preview.error===0"));
            control(connection, origin, "{\"status\":429,\"failures\":-1,\"retry_after\":\"60\"}"); queue(web, scenario, gen, "D1111111111");
            waitFor(web, scenario, "window.__preview?.errorStatus===429 && !!document.querySelector('[data-program-retry]')?.disabled");
            int before = stats(connection, origin).getJSONArray("requests").length();
            web.evaluate(scenario, "window.__blocked=null;window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'retry',index:0,key:window.__preview.items[0].key,queueToken:window.__preview.queueToken}).then(()=>window.__blocked=false,()=>window.__blocked=true)");
            waitFor(web, scenario, "window.__blocked===true");
            web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + gen + ",action:'play'})"); Thread.sleep(500);
            assertEquals(before, stats(connection, origin).getJSONArray("requests").length());
            web.evaluate(scenario, "document.querySelector('[data-program-close]').click()");
            waitFor(web, scenario, "window.__preview?.items.length===0 && !window.__preview.preview && !document.querySelector('[data-testid=android-program]')");
            assertNotNull(connection.cookieHeader(gen)); assertEquals(gen, connection.getGeneration());
            // Closing while an automatic retry is scheduled must prevent another request.
            control(connection, origin, "{\"status\":503,\"failures\":-1,\"retry_after\":\"2\"}"); queue(web, scenario, gen, "D1111111111");
            waitFor(web, scenario, "window.__preview?.preview?.retryPending===true");
            web.evaluate(scenario, "document.querySelector('[data-program-close]').click()");
            waitFor(web, scenario, "window.__preview?.items.length===0"); before = stats(connection, origin).getJSONArray("requests").length(); Thread.sleep(2500);
            assertEquals(before, stats(connection, origin).getJSONArray("requests").length());
            control(connection, origin, "{\"status\":403,\"failures\":-1}"); queue(web, scenario, gen, "D1111111111");
            waitFor(web, scenario, "window.__preview?.errorStatus===403 && !document.querySelector('[data-program-retry]')");
            control(connection, origin, "{\"status\":0,\"slow\":true}"); queue(web, scenario, gen, "D1111111111");
            waitFor(web, scenario, "window.__preview?.preview?.preparation?.state==='streamable' && window.__preview.playing");
            assertTrue(stats(connection, origin).getJSONObject("readers").optInt("D1111111111") > 0);
            web.evaluate(scenario, "document.querySelector('[data-program-close]').click()");
            waitFor(web, scenario, "window.__preview?.items.length===0 && !window.__preview.preview");
            long closeDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (stats(connection, origin).getJSONObject("readers").optInt("D1111111111") > 0 && System.nanoTime() < closeDeadline) Thread.sleep(100);
            assertEquals(0, stats(connection, origin).getJSONObject("readers").optInt("D1111111111"));
            queue(web, scenario, gen, "E1111111111");
            waitFor(web, scenario, "window.__preview?.id==='E1111111111' && window.__preview.preview?.preparation?.state==='streamable' && window.__preview.playing");
            assertEquals("true", web.evaluate(scenario, "window.__preview.seekable || document.querySelector('[aria-label=\"Playback position\"]')?.disabled"));
            web.evaluate(scenario, "document.querySelector('[data-program-close]').click()");
            waitFor(web, scenario, "window.__preview?.items.length===0");
            control(connection, origin, "{\"status\":401,\"failures\":-1}"); queue(web, scenario, gen, "D1111111111");
            waitFor(web, scenario, "!!document.querySelector('input[type=password]') && !document.querySelector('[data-testid=android-program]')");
        } finally { control(connection, origin, "{\"status\":0,\"slow\":false,\"cut\":false}"); connection.clearSession(true); }
    }
}
