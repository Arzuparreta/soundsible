package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import android.content.ComponentName;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Samples from the sole service's real AudioSink, not a second player or speaker recording. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public class ProgramPcmTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail("PCM condition timed out: " + web.evaluate(scenario, "(()=>{const clone=document.body.cloneNode(true);clone.querySelectorAll('[data-subsonic-secret],input,script,style').forEach(e=>e.remove());return clone.textContent})()"));
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        String button = "Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length>0&&!b.disabled&&b.textContent.trim()===" + JSONObject.quote(label) + ")";
        waitFor(scenario, "!!" + button); web.evaluate(scenario, button + ".click()");
    }
    private JSONObject api(EngineConnection connection, String origin, String path, String method, JSONObject body) throws Exception {
        var request = new okhttp3.Request.Builder().url(origin + path).header("Cookie", connection.cookieHeader(connection.getGeneration()));
        if (path.startsWith("/__fixture/")) request.header("X-Android-Fixture", "isolated");
        if (!method.equals("GET")) request.method(method, okhttp3.RequestBody.create(body == null ? "{}" : body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(request.build()).execute()) {
            assertEquals("PCM API status: " + path, 200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private void observe(ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario, "window.__pcmTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__pcm=s),100)");
        waitFor(scenario, "window.__pcm?.ready");
    }
    private JSONObject state(ActivityScenario<MainActivity> scenario) throws Exception {
        return new JSONObject(new JSONArray("[" + web.evaluate(scenario, "JSON.stringify(window.__pcm)") + "]").getString(0));
    }
    private void settings(ActivityScenario<MainActivity> scenario) throws Exception {
        // Resume refresh may replace the browse subtree. Resolve current nodes separately.
        waitFor(scenario, "(()=>{const tab=document.querySelector('[data-android-settings]');if(tab?.getAttribute('aria-pressed')!=='true')tab?.click();return !!document.querySelector('[data-android-settings-playback]')})()");
        waitFor(scenario, "(()=>{document.querySelector('[data-android-settings-playback]')?.click();return !!document.querySelector('[data-setting=volume-leveling] [role=switch]')})()");
    }
    private void level(ActivityScenario<MainActivity> scenario, boolean wanted) throws Exception {
        settings(scenario);
        String current = web.evaluate(scenario, "document.querySelector('[data-setting=volume-leveling] [role=switch]').getAttribute('aria-checked')");
        if (!current.equals(JSONObject.quote(Boolean.toString(wanted)))) web.evaluate(scenario, "document.querySelector('[data-setting=volume-leveling] [role=switch]').click()");
        waitFor(scenario, "window.__pcm?.leveling?.settingsPhase==='ready'&&window.__pcm.leveling.enabled===" + wanted);
    }
    private void command(ActivityScenario<MainActivity> scenario, JSONObject command) throws Exception {
        web.evaluate(scenario, "window.__pcmAccepted=false;Capacitor.Plugins.SoundsiblePlayback.command({..." + command + ",generation:window.__pcm.generation}).then(()=>window.__pcmAccepted=true)");
        waitFor(scenario, "window.__pcmAccepted");
    }
    private String currentKey(JSONObject state) throws Exception { return state.getJSONArray("items").getJSONObject(state.getInt("index")).getString("key"); }
    private static class Sample {
        final String key; final int peak; final long frame; final long offset; final int rate;
        Sample(String key, int peak, long frame, long offset, int rate) { this.key = key; this.peak = peak; this.frame = frame; this.offset = offset; this.rate = rate; }
    }
    static class Probe implements AutoCloseable {
        final ArrayBlockingQueue<Sample> samples = new ArrayBlockingQueue<>(16);
        final ProgramPcmTap.Capture capture;
        Probe(long generation) {
            capture = NativeProgramOutput.INSTANCE.subscribe(generation, block -> {
                var bytes = ByteBuffer.wrap(block.getBytes()).order(ByteOrder.LITTLE_ENDIAN); int peak = 0;
                while (bytes.hasRemaining()) peak = Math.max(peak, Math.abs((int) bytes.getShort()));
                samples.offer(new Sample(block.getStream().getKey(), peak, block.getFrameOffset(), block.getStream().getPositionOffsetUs(), block.getSampleRate()));
                return kotlin.Unit.INSTANCE;
            });
        }
        void await(String key, int wanted, long minimumOffset) throws Exception {
            samples.clear(); long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20); int latest = -1;
            while (System.nanoTime() < until) {
                Sample sample = samples.poll(200, TimeUnit.MILLISECONDS); if (sample == null || !sample.key.equals(key)) continue;
                latest = sample.peak;
                if (sample.frame >= sample.rate / 5 && sample.offset >= minimumOffset && Math.abs(sample.peak - wanted) <= 2) return;
            }
            fail("Expected post-DSP synthetic peak " + wanted + ", last peak " + latest);
        }
        @Override public void close() { capture.close(); samples.clear(); }
    }
    private double gain(JSONObject row) throws Exception {
        double lufs = row.getDouble("loudness_lufs"), peak = row.getDouble("loudness_peak_dbtp");
        double desired = Math.max(-20, Math.min(6, -18 - lufs));
        return Math.pow(10, Math.max(-20, Math.min(6, Math.min(desired, -1 - peak))) / 20);
    }
    private JSONObject row(EngineConnection connection, String origin, String id) throws Exception {
        var rows = api(connection, origin, "/api/library", "GET", null).getJSONArray("tracks");
        for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).getString("id").equals(id)) return rows.getJSONObject(i);
        throw new AssertionError("Synthetic PCM track missing from the real library");
    }
    @Test public void httpPcm() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsPcm() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin); var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true); boolean original = true;
        AtomicReference<MediaController> controller = new AtomicReference<>();
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')"); observe(scenario);
            original = api(connection, origin, "/api/discovery/settings", "GET", null).getBoolean("volume_leveling");
            api(connection, origin, "/__fixture/loudness-facts", "POST", new JSONObject().put("measured", false));
            level(scenario, false); // Settings before the first programme must be usable.
            click(scenario, "Library"); web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
            waitFor(scenario, "window.__pcm?.playing"); JSONObject initial = state(scenario); String key = currentKey(initial), programme = initial.getString("programToken"), keys = initial.getJSONArray("items").toString(), cookie = connection.cookieHeader(connection.getGeneration());
            try (var probe = new Probe(connection.getGeneration())) {
                probe.await(key, 3000, 0); level(scenario, true); probe.await(key, 1893, 0);
                assertTrue(api(connection, origin, "/api/discovery/settings", "GET", null).getBoolean("volume_leveling"));
                var future = new MediaController.Builder(context, new SessionToken(context, new ComponentName(context, PlaybackService.class))).buildAsync();
                controller.set(future.get(10, TimeUnit.SECONDS)); scenario.onActivity(activity -> controller.get().setVolume(0.1f));
                AtomicReference<Float> localVolume = new AtomicReference<>(1f);
                long volumeUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                do {
                    scenario.onActivity(activity -> localVolume.set(controller.get().getVolume()));
                    if (Math.abs(localVolume.get() - 0.1f) < 0.001f) break;
                    Thread.sleep(100);
                } while (System.nanoTime() < volumeUntil);
                assertEquals(0.1f, localVolume.get(), 0.001f);
                probe.await(key, 1893, 0); // Local output volume never changes the post-DSP program tap.
                command(scenario, new JSONObject().put("action", "seek").put("positionMs", 10000)); probe.await(key, 1893, 9000000);
                click(scenario, "Pause"); waitFor(scenario, "!window.__pcm.playWhenReady"); scenario.recreate();
                waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')"); observe(scenario);
                assertEquals(programme, state(scenario).getString("programToken")); assertEquals(keys, state(scenario).getJSONArray("items").toString()); assertTrue(cookie.equals(connection.cookieHeader(connection.getGeneration())));
                click(scenario, "Play"); waitFor(scenario, "window.__pcm.playing"); scenario.moveToState(Lifecycle.State.CREATED); probe.await(key, 1893, 0); scenario.moveToState(Lifecycle.State.RESUMED);
                level(scenario, false); probe.await(key, 3000, 0); level(scenario, true);
                api(connection, origin, "/__fixture/loudness-facts", "POST", new JSONObject().put("album", true));
                JSONObject first = row(connection, origin, "member-track"), second = row(connection, origin, "member-pcm-loud");
                click(scenario, "Refresh"); waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]')&&!document.querySelector('[data-testid=android-configured] header button').disabled"); click(scenario, "Library");
                waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-pcm-loud] [data-row-main]')");
                waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')"); web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
                waitFor(scenario, "window.__pcm.playing&&window.__pcm.programToken!==" + JSONObject.quote(programme)); probe.await(currentKey(state(scenario)), (int) Math.round(3000 * gain(first)), 0);
                click(scenario, "Albums");
                String album = "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(e=>e.textContent.includes('member album'))"; waitFor(scenario, "!!" + album); web.evaluate(scenario, album + ".click()");
                waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')"); web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
                waitFor(scenario, "window.__pcm.playing&&window.__pcm.items.length===2");
                double energy = first.getDouble("duration") * Math.pow(10, (first.getDouble("loudness_lufs") + 0.691) / 10) + second.getDouble("duration") * Math.pow(10, (second.getDouble("loudness_lufs") + 0.691) / 10);
                double reference = -0.691 + 10 * Math.log10(energy / (first.getDouble("duration") + second.getDouble("duration")));
                JSONObject albumFacts = new JSONObject().put("loudness_lufs", reference).put("loudness_peak_dbtp", Math.max(first.getDouble("loudness_peak_dbtp"), second.getDouble("loudness_peak_dbtp")));
                double albumGain = gain(albumFacts); JSONObject albumState = state(scenario); String albumKey = currentKey(albumState);
                probe.await(albumKey, (int) Math.round(3000 * albumGain), 0);
                command(scenario, new JSONObject().put("action", "shuffle").put("enabled", true)); probe.await(albumKey, (int) Math.round(3000 * gain(first)), 0);
                command(scenario, new JSONObject().put("action", "shuffle").put("enabled", false)); probe.await(albumKey, (int) Math.round(3000 * albumGain), 0);
                var items = state(scenario).getJSONArray("items"); int louder = items.getJSONObject(0).getString("id").equals("member-pcm-loud") ? 0 : 1;
                command(scenario, new JSONObject().put("action", "select").put("index", louder).put("key", items.getJSONObject(louder).getString("key")).put("queueToken", state(scenario).getString("queueToken")));
                waitFor(scenario, "window.__pcm.id==='member-pcm-loud'&&window.__pcm.playing"); probe.await(currentKey(state(scenario)), (int) Math.round(9000 * albumGain), 0);
                assertEquals(albumState.getString("programToken"), state(scenario).getString("programToken"));
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
                var copied = new JSONArray().put(first).put(second);
                web.evaluate(scenario, "window.__pcmCopied=false;Capacitor.Plugins.SoundsibleOffline.command({action:'prepare',generation:window.__pcm.generation,tracks:" + copied + ",playlists:{}}).then(()=>window.__pcmCopied=true)");
                waitFor(scenario, "window.__pcmCopied");
                long copyUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
                while (connection.getOffline().local("member-track", connection.getGeneration()) == null || connection.getOffline().local("member-pcm-loud", connection.getGeneration()) == null) {
                    assertTrue("Measured synthetic copies did not finish", System.nanoTime() < copyUntil); Thread.sleep(100);
                }
                var savedCopies = connection.getOffline().state(connection.getGeneration()).getJSONArray("items");
                for (int i = 0; i < savedCopies.length(); i++) {
                    var copy = savedCopies.getJSONObject(i).getJSONObject("track");
                    var measured = copy.getString("id").equals("member-track") ? first : second;
                    assertEquals(measured.getDouble("loudness_lufs"), copy.getDouble("loudness_lufs"), 0);
                    assertEquals(measured.getDouble("loudness_peak_dbtp"), copy.getDouble("loudness_peak_dbtp"), 0);
                }
                api(connection, origin, "/__fixture/connection-failure", "POST", new JSONObject().put("enabled", true).put("status", 503));
                click(scenario, "Refresh"); waitFor(scenario, "document.querySelector('[data-testid=android-configured] [role=status]')?.textContent.includes(\"Couldn't reach your station\")");
                click(scenario, "Library"); click(scenario, "Songs");
                waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')"); web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
                waitFor(scenario, "window.__pcm.playing&&window.__pcm.id==='member-track'&&window.__pcm.items.every(i=>i.offline===true)");
                probe.await(currentKey(state(scenario)), (int) Math.round(3000 * gain(first)), 0);
                String offlineSongsProgram = state(scenario).getString("programToken");
                click(scenario, "Albums"); waitFor(scenario, "!!" + album); web.evaluate(scenario, album + ".click()");
                waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')"); web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
                waitFor(scenario, "window.__pcm.playing&&window.__pcm.items.length===2&&window.__pcm.items.every(i=>i.offline===true)&&window.__pcm.programToken!==" + JSONObject.quote(offlineSongsProgram));
                probe.await(currentKey(state(scenario)), (int) Math.round(3000 * albumGain), 0);
            }
        } finally {
            try {
                if (controller.get() != null) { InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { controller.get().setVolume(1f); controller.get().release(); }); }
                if (connection.cookieHeader(connection.getGeneration()) != null) {
                    api(connection, origin, "/__fixture/connection-failure", "POST", new JSONObject().put("enabled", false));
                    connection.getOffline().remove(connection.getGeneration(), new JSONArray().put("member-track").put("member-pcm-loud"));
                    api(connection, origin, "/api/discovery/settings", "PATCH", new JSONObject().put("volume_leveling", original));
                    api(connection, origin, "/__fixture/loudness-facts", "POST", new JSONObject().put("measured", false));
                    var rows = api(connection, origin, "/api/library", "GET", null).getJSONArray("tracks");
                    for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).getString("id").equals("member-pcm-loud")) api(connection, origin, "/api/library/tracks/member-pcm-loud", "DELETE", null);
                }
            } finally { connection.clearSession(true); }
        }
    }
}
