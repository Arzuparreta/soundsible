package com.soundsible.android;

import static org.junit.Assert.*;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the actual packaged Solid assets and native App.getInfo plugin. */
@RunWith(AndroidJUnit4.class)
public class StartupTest {
    private String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView web = activity.getBridge().getWebView();
            web.evaluateJavascript(script, result -> { value.set(result); done.countDown(); });
        });
        assertTrue("WebView did not answer", done.await(5, TimeUnit.SECONDS));
        return value.get();
    }

    private void awaitReady(ActivityScenario<MainActivity> scenario) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if ("true".equals(evaluate(scenario,
                "!!document.querySelector('[data-testid=android-unconfigured]') && " +
                "!document.documentElement.hasAttribute('data-booting')"))) return;
            Thread.sleep(200);
        }
        fail("Packaged Android startup did not complete: " + evaluate(scenario, "document.body.innerText"));
    }

    @Test public void packagedStartupAndOfflineReopen() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitReady(scenario);
            String version = InstrumentationRegistry.getArguments().getString("expectedVersion");
            assertNotNull(version);
            assertEquals("\"" + version + "\"", evaluate(scenario, "document.getElementById('app').dataset.nativeVersion"));
            assertEquals("\"com.soundsible.android.dev\"", evaluate(scenario, "document.getElementById('app').dataset.nativeApplication"));
            assertEquals("\"" + BuildConfig.SOURCE_REVISION + "\"", evaluate(scenario, "document.getElementById('app').dataset.nativeRevision"));
            assertEquals("false", evaluate(scenario, "performance.getEntriesByType('resource').some(e => /\\/api\\/|\\/socket.io\\//.test(e.name))"));
            assertEquals("false", evaluate(scenario, "!!navigator.serviceWorker?.controller"));
            evaluate(scenario, "localStorage.setItem('lang', 'es'); localStorage.setItem('theme', 'dark')");
            // Actual reload re-fetches locale/font chunks from packaged assets;
            // the smoke runner disables emulator connectivity before this test.
            scenario.recreate();
            awaitReady(scenario);
            assertEquals("\"es\"", evaluate(scenario, "document.documentElement.lang"));
            assertEquals("\"dark\"", evaluate(scenario, "document.documentElement.dataset.theme"));
            assertEquals("\"Conecta tu Soundsible\"", evaluate(scenario, "document.querySelector('h1').textContent"));
            assertEquals("false", evaluate(scenario, "Array.from(document.images).some(i => !i.complete || !i.naturalWidth)"));
            assertEquals("true", evaluate(scenario, "document.fonts.check('16px \"Plus Jakarta Sans\"')"));
        }
    }
}
