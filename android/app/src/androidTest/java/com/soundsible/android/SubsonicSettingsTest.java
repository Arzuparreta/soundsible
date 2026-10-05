package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.ClipboardManager;
import android.content.ClipDescription;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Actual credential effects and OS clipboard; failures never print credentials. */
@RunWith(AndroidJUnit4.class)
public class SubsonicSettingsTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        // No condition operands or unredacted DOM: either could contain a credential.
        fail("Subsonic UI condition timed out: " + web.evaluate(scenario,
            "(()=>{const clone=document.body.cloneNode(true);clone.querySelectorAll('[data-subsonic-secret],input').forEach(e=>e.remove());return clone.innerText})()"));
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        String button = "Array.from((document.querySelector('[role=dialog]')||document.querySelector('[data-testid=android-settings-account]')||document).querySelectorAll('button')).find(b=>b.getClientRects().length>0&&!b.disabled&&b.textContent.startsWith(" + JSONObject.quote(label) + "))";
        waitFor(scenario, "!!" + button); web.evaluate(scenario, button + ".click()");
    }
    private JSONObject api(EngineConnection connection, String origin, String cookie, String method, JSONObject body) throws Exception {
        var request = new okhttp3.Request.Builder().url(origin + "/api/auth/subsonic").header("Cookie", cookie);
        if (!method.equals("GET")) request.method(method, okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(request.build()).execute()) {
            assertEquals("Subsonic credential status", 200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private String loginCookie(EngineConnection connection, String origin, String username) throws Exception {
        var body = new JSONObject().put("username", username).put("password", "android-test");
        var request = new okhttp3.Request.Builder().url(origin + "/api/auth/login").post(okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(request.build()).execute()) {
            assertEquals(200, response.code());
            for (String value : response.headers("Set-Cookie")) {
                var cookie = okhttp3.Cookie.parse(response.request().url(), value);
                if (cookie != null && cookie.name().equals("sb_session")) return cookie.name() + "=" + cookie.value();
            }
        }
        throw new AssertionError("Fixture owner login did not yield a session");
    }
    private boolean authenticates(EngineConnection connection, String origin, String username, String password) throws Exception {
        // Form POST keeps secrets out of request URLs and access logs. No session cookie.
        var body = new okhttp3.FormBody.Builder().add("u", username).add("p", password).add("c", "android-acceptance").add("v", "1.16.1").add("f", "json").build();
        var request = new okhttp3.Request.Builder().url(origin + "/rest/ping").post(body).build();
        try (var response = connection.getClient().newCall(request).execute()) {
            assertEquals("Subsonic protocol HTTP status", 200, response.code());
            return new JSONObject(response.body().string()).getJSONObject("subsonic-response").getString("status").equals("ok");
        }
    }
    private String secret(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "!!document.querySelector('[data-subsonic-secret]')?.textContent");
        return new JSONArray("[" + web.evaluate(scenario, "document.querySelector('[data-subsonic-secret]').textContent") + "]").getString(0);
    }
    private void clipboard(ActivityScenario<MainActivity> scenario, String expected, boolean sensitive) {
        AtomicBoolean matches = new AtomicBoolean();
        scenario.onActivity(activity -> {
            var manager = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            var clip = manager.getPrimaryClip();
            matches.set(clip != null && clip.getItemCount() == 1 && expected.contentEquals(clip.getItemAt(0).getText()) &&
                clip.getDescription().getExtras() != null && clip.getDescription().getExtras().getBoolean(ClipDescription.EXTRA_IS_SENSITIVE) == sensitive);
        });
        assertTrue("The OS clipboard must contain the requested value and sensitivity", matches.get());
    }
    private void open(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "!!document.querySelector('[data-android-settings]')");
        web.evaluate(scenario, "document.querySelector('[data-android-settings]').click();document.querySelector('[data-android-settings-subsonic]').click()");
        waitFor(scenario, "!!document.querySelector('[data-setting=subsonic-server]')&&!document.querySelector('[data-testid=android-subsonic-settings]').getAttribute('aria-busy').includes('true')");
    }
    @Test public void httpSubsonic() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsSubsonic() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        String owner = null, member = null;
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-main]')");
            member = connection.cookieHeader(connection.getGeneration()); assertTrue(member != null);
            owner = loginCookie(connection, origin, "owner");
            String ownerSecret = api(connection, origin, owner, "POST", new JSONObject()).getString("password");
            assertTrue(authenticates(connection, origin, "owner", ownerSecret));
            web.evaluate(scenario, "window.__subsonicTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__subsonicProgram=s),100);document.querySelector('[data-browse-track-id=member-track] [data-row-main]').click()");
            waitFor(scenario, "window.__subsonicProgram?.playing"); click(scenario, "Pause"); waitFor(scenario, "!window.__subsonicProgram.playWhenReady");
            String program = web.evaluate(scenario, "window.__subsonicProgram.programToken"), keys = web.evaluate(scenario, "JSON.stringify(window.__subsonicProgram.items.map(i=>i.key))");
            open(scenario); click(scenario, "Copy the address"); waitFor(scenario, "Array.from(document.querySelectorAll('[role=status]')).some(e=>e.textContent.includes('Copied'))"); clipboard(scenario, origin, false);
            click(scenario, "Generate a password"); String first = secret(scenario); assertTrue(authenticates(connection, origin, "member", first));
            JSONObject stored = api(connection, origin, member, "GET", null); assertTrue(stored.getBoolean("configured")); assertFalse(stored.has("password"));
            click(scenario, "Copy the password"); waitFor(scenario, "Array.from(document.querySelectorAll('[role=status]')).some(e=>e.textContent.includes('Copied'))"); clipboard(scenario, first, true);
            click(scenario, "Generate a new password"); waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Cancel"); waitFor(scenario, "!document.querySelector('[role=dialog]')"); assertTrue(authenticates(connection, origin, "member", first));
            click(scenario, "Generate a new password"); waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Generate a password");
            waitFor(scenario, "!document.querySelector('[role=dialog]')&&!document.querySelector('[data-testid=android-subsonic-settings]').getAttribute('aria-busy').includes('true')");
            String second = secret(scenario); assertFalse(first.equals(second)); assertFalse(authenticates(connection, origin, "member", first)); assertTrue(authenticates(connection, origin, "member", second));
            assertEquals(program, web.evaluate(scenario, "window.__subsonicProgram.programToken")); assertEquals(keys, web.evaluate(scenario, "JSON.stringify(window.__subsonicProgram.items.map(i=>i.key))")); assertTrue(member.equals(connection.cookieHeader(connection.getGeneration())));
            scenario.recreate(); waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]')&&!document.documentElement.hasAttribute('data-booting')"); open(scenario);
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('[data-subsonic-secret]')")); assertTrue(authenticates(connection, origin, "member", second));
            click(scenario, "Revoke access"); waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Cancel"); waitFor(scenario, "!document.querySelector('[role=dialog]')"); assertTrue(authenticates(connection, origin, "member", second));
            click(scenario, "Revoke access"); waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Revoke access");
            waitFor(scenario, "!document.querySelector('[role=dialog]')&&!document.querySelector('[data-testid=android-subsonic-settings]').getAttribute('aria-busy').includes('true')");
            assertFalse(api(connection, origin, member, "GET", null).getBoolean("configured")); assertFalse(authenticates(connection, origin, "member", second)); assertTrue(authenticates(connection, origin, "owner", ownerSecret));
            long generation = connection.getGeneration();
            web.evaluate(scenario, "window.__copyRefused=null;Capacitor.Plugins.SoundsibleClipboard.write({generation:" + (generation - 1) + ",text:'stale-fixture-copy',sensitive:false}).catch(e=>window.__copyRefused=e.code)"); waitFor(scenario, "window.__copyRefused==='COPY_SESSION_CHANGED'"); clipboard(scenario, first, true);
            click(scenario, "Generate a password"); String third = secret(scenario);
            assertTrue(authenticates(connection, origin, "member", third));
            web.evaluate(scenario, "document.querySelector('[data-android-settings-account]').click()");
            click(scenario, "Sign out"); waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Sign out");
            waitFor(scenario, "!!document.querySelector('input[type=password]')&&!document.querySelector('[data-subsonic-secret]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='owner';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=owner-track] [data-row-main]')"); open(scenario);
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('[data-subsonic-secret]')"));
            assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-setting=subsonic-username]').textContent.includes('owner')&&!document.querySelector('[data-setting=subsonic-username]').textContent.includes('member')"));
            assertTrue(authenticates(connection, origin, "owner", ownerSecret)); assertTrue(authenticates(connection, origin, "member", third));
            member = loginCookie(connection, origin, "member"); owner = connection.cookieHeader(connection.getGeneration());
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
        } finally {
            try { if (member != null) api(connection, origin, loginCookie(connection, origin, "member"), "DELETE", new JSONObject()); if (owner != null) api(connection, origin, loginCookie(connection, origin, "owner"), "DELETE", new JSONObject()); }
            finally { connection.clearSession(true); }
        }
    }
}
