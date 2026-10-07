package com.soundsible.android;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import java.util.Map;
import java.util.List;
import java.util.TreeMap;
import java.util.ArrayList;
import java.io.File;
import java.io.FileInputStream;
import java.util.function.Function;
import org.json.JSONObject;
import org.junit.Test;

/** Runs before/after an actual PackageManager update, without uninstalling or clearing data. */
@androidx.media3.common.util.UnstableApi
public class ReleaseUpdateTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (!"true".equals(web.evaluate(scenario, condition))) {
            assertTrue("Release update precondition: " + condition, System.nanoTime() < deadline);
            Thread.sleep(100);
        }
    }
    private String digest(String value) throws Exception {
        return java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    static Map<String, String> readyCopies(JSONObject state, Function<String, File> local) throws Exception {
        Map<String, String> copies = new TreeMap<>();
        var items = state.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) {
            var item = items.getJSONObject(i);
            String id = item.getJSONObject("track").getString("id");
            assertEquals("Retained copy is not ready: " + id, "ready", item.getString("state"));
            File file = local.apply(id);
            assertNotNull("Retained copy is unavailable: " + id, file);
            var hash = MessageDigest.getInstance("SHA-256");
            try (var input = new FileInputStream(file)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
            }
            assertNull("Duplicate copy identity: " + id,
                copies.put(id, java.util.Base64.getEncoder().encodeToString(hash.digest())));
        }
        return copies;
    }
    static Map<String, String> copyDigests(JSONObject snapshot) throws Exception {
        Map<String, String> copies = new TreeMap<>();
        var keys = snapshot.keys();
        while (keys.hasNext()) { String key = keys.next(); copies.put(key, snapshot.getString(key)); }
        return copies;
    }
    static Map<String, List<String>> playlistContents(JSONObject snapshot) throws Exception {
        Map<String, List<String>> playlists = new TreeMap<>();
        var keys = snapshot.keys();
        while (keys.hasNext()) {
            String key = keys.next(); var items = snapshot.getJSONArray(key);
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) ids.add(items.getString(i));
            playlists.put(key, ids);
        }
        return playlists;
    }
    @Test public void retainedAccountAndCopies() throws Exception {
        var args = InstrumentationRegistry.getArguments();
        org.junit.Assume.assumeNotNull(args.getString("updatePhase"));
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.soundsible.android", context.getPackageName());
        assertFalse(BuildConfig.DEBUG);
        var connection = EngineConnection.shared(context);
        var prefs = context.getSharedPreferences("release-update-test", Context.MODE_PRIVATE);
        assertEquals(args.getString("fixtureOrigin"), connection.getOrigin());
        assertFalse(connection.cookieHeader(connection.getGeneration()).isEmpty());
        assertNotNull(connection.getOffline().local("member-track", connection.getGeneration()));
        var web = new StartupTest();
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!"true".equals(web.evaluate(scenario, "!!document.querySelector('[data-row-main]')"))) {
                assertTrue("Offline library did not open", System.nanoTime() < deadline); Thread.sleep(100);
            }
            if ("seed".equals(args.getString("updatePhase"))) {
                // Exercise real preference controls and await their asynchronous locale load.
                web.evaluate(scenario, "document.querySelector('[data-android-settings]').click()");
                waitFor(web, scenario, "!!document.querySelector('[data-android-settings-appearance]')");
                web.evaluate(scenario, "document.querySelector('[data-android-settings-appearance]').click()");
                waitFor(web, scenario, "!!document.querySelector('[data-setting=language] select')");
                web.evaluate(scenario, "document.querySelector('[data-setting=theme] input[value=dark]').click();let language=document.querySelector('[data-setting=language] select');language.value='es';language.dispatchEvent(new Event('change',{bubbles:true}))");
                waitFor(web, scenario, "document.documentElement.lang==='es' && document.documentElement.dataset.theme==='dark'");
                scenario.recreate();
                waitFor(web, scenario, "document.documentElement.lang==='es' && document.documentElement.dataset.theme==='dark' && !!document.querySelector('[data-row-main]')");
                assertTrue(prefs.edit().putString("cookie", digest(connection.cookieHeader(connection.getGeneration())))
                    .putString("offline-copies", new JSONObject(readyCopies(
                        connection.getOffline().state(connection.getGeneration()),
                        id -> connection.getOffline().local(id, connection.getGeneration()))).toString())
                    .putString("offline-playlists", connection.getOffline().state(connection.getGeneration())
                        .getJSONObject("playlists").toString()).commit());
            } else {
                assertEquals("verify", args.getString("updatePhase"));
                assertEquals(prefs.getString("cookie", null), digest(connection.cookieHeader(connection.getGeneration())));
                assertEquals(copyDigests(new JSONObject(prefs.getString("offline-copies", null))),
                    readyCopies(connection.getOffline().state(connection.getGeneration()),
                        id -> connection.getOffline().local(id, connection.getGeneration())));
                assertEquals(playlistContents(new JSONObject(prefs.getString("offline-playlists", null))),
                    playlistContents(connection.getOffline().state(connection.getGeneration()).getJSONObject("playlists")));
                assertEquals("\"es\"", web.evaluate(scenario, "document.documentElement.lang"));
                assertEquals("\"dark\"", web.evaluate(scenario, "document.documentElement.dataset.theme"));
            }
        }
    }
}
