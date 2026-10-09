package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual private filesystem refusal must keep a recoverable, unavailable copy in the manager. */
@RunWith(AndroidJUnit4.class)
public class OfflineRemovalTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail(condition + ": " + web.evaluate(scenario, "document.body.innerText") + " errors=" + web.evaluate(scenario, "JSON.stringify(window.__removalErrors)"));
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        waitFor(scenario, "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ")");
        web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ").click()");
    }
    @Test public void httpRemovalFailureRecovery() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsRemovalFailureRecovery() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        File partial = null, held = null;
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "window.__removalErrors=[];window.addEventListener('error',e=>window.__removalErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__removalErrors.push(String(e.reason)))");
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-menu]')");
            String cookie = connection.cookieHeader(connection.getGeneration()); assertNotNull(cookie);
            web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-menu]').click()"); click(scenario, "Available offline");
            var store = OfflineStore.shared(context); long generation = connection.getGeneration();
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            File audio;
            while ((audio = store.local("member-track", generation)) == null) { assertTrue("Copy must be ready before injecting a real deletion refusal", System.nanoTime() < until); Thread.sleep(100); }
            partial = new File(audio.getParentFile(), audio.getName().replace(".audio", ".part"));
            held = new File(partial, "held");
            // The copy reads as ready before the download's finally deletes its
            // own .part path, so a directory made here at once can be removed
            // under the write. Plant it until it survives that cleanup.
            until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (true) {
                assertTrue("Could not plant the held file", System.nanoTime() < until);
                try {
                    if (!partial.isDirectory()) assertTrue(partial.mkdir());
                    Files.write(held.toPath(), "synthetic held file".getBytes(StandardCharsets.UTF_8));
                } catch (java.nio.file.NoSuchFileException removed) {
                    continue;
                }
                Thread.sleep(500);
                if (held.exists()) break;
            }
            web.evaluate(scenario, "document.querySelector('[data-library-menu]').click()"); click(scenario, "Manage offline music");
            waitFor(scenario, "!!document.querySelector('[data-testid=android-offline-manager]')");
            click(scenario, "Remove from this device");
            waitFor(scenario, "document.querySelector('[data-testid=android-offline-manager]')?.textContent.includes('Could not remove the copy. Try again.')");
            assertEquals("A local deletion refusal must not mark the reachable station offline", "false", web.evaluate(scenario, "document.body.innerText.includes(\"Couldn't reach your station\")"));
            assertEquals("A local deletion refusal must retain the connected saved preview library", "true", web.evaluate(scenario, "!!document.querySelector('[data-browse-track-id=B1111111111]')"));
            var item = store.state(generation).getJSONArray("items").getJSONObject(0);
            assertEquals("error", item.getString("state")); assertEquals("storage", item.getString("error"));
            assertNull(store.local("member-track", generation)); assertFalse(audio.exists()); assertTrue(held.exists());
            assertEquals("false", web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-offline-manager] button')).some(b=>b.textContent==='Retry')"));
            assertTrue(held.delete()); assertTrue(partial.delete());
            click(scenario, "Remove from this device");
            waitFor(scenario, "document.querySelector('[data-testid=android-offline-manager]')?.textContent.includes('No songs prepared yet.')");
            assertEquals(0, store.state(generation).getJSONArray("items").length());
            assertTrue("Removing a copy must preserve the account", cookie.equals(connection.cookieHeader(generation)));
            try (var response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/api/static/stream/member-track").header("Cookie", cookie).header("Range", "bytes=0-31").build()).execute()) {
                assertEquals("Removing a copy must preserve the engine file", 206, response.code()); assertEquals(32, response.body().bytes().length);
            }
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
        } finally {
            if (held != null) held.delete(); if (partial != null) partial.delete();
            connection.clearSession(true);
        }
    }
}
