package com.soundsible.android;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

/** Runs before/after an actual PackageManager update, without uninstalling or clearing data. */
@androidx.media3.common.util.UnstableApi
public class ReleaseUpdateTest {
    private String digest(String value) throws Exception {
        return java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
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
                web.evaluate(scenario, "localStorage.setItem('lang','es');localStorage.setItem('theme','dark')");
                assertTrue(prefs.edit().putString("cookie", digest(connection.cookieHeader(connection.getGeneration())))
                    .putString("offline", connection.getOffline().state(connection.getGeneration()).toString()).commit());
            } else {
                assertEquals("verify", args.getString("updatePhase"));
                assertEquals(prefs.getString("cookie", null), digest(connection.cookieHeader(connection.getGeneration())));
                assertEquals(prefs.getString("offline", null), connection.getOffline().state(connection.getGeneration()).toString());
                assertEquals("\"es\"", web.evaluate(scenario, "localStorage.getItem('lang')"));
                assertEquals("\"dark\"", web.evaluate(scenario, "localStorage.getItem('theme')"));
            }
        }
    }
}
