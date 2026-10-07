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

/** Real own-profile/password/session rotation without replacing the native program or copies. */
@RunWith(AndroidJUnit4.class)
public class AccountSettingsTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail(condition + ": " + web.evaluate(scenario, "document.body.innerText") + " logout=" + web.evaluate(scenario, "JSON.stringify(window.__accountLogout)"));
    }
    private JSONObject api(EngineConnection connection, String origin, String cookie, String path, String method, JSONObject body) throws Exception {
        var builder = new okhttp3.Request.Builder().url(origin + path).header("Cookie", cookie);
        if (!method.equals("GET")) builder.method(method, okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(builder.build()).execute()) {
            assertEquals(path + " status", 200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private String ownerLogin(EngineConnection connection, String origin) throws Exception {
        var body = new JSONObject().put("username", "owner").put("password", "android-test");
        var builder = new okhttp3.Request.Builder().url(origin + "/api/auth/login").post(okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(builder.build()).execute()) {
            assertEquals(200, response.code());
            for (String value : response.headers("Set-Cookie")) {
                var cookie = okhttp3.Cookie.parse(response.request().url(), value);
                if (cookie != null && cookie.name().equals("sb_session")) return cookie.name() + "=" + cookie.value();
            }
        }
        throw new AssertionError("Fixture owner login must yield a native session");
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        String action = "Array.from((document.querySelector('[role=dialog]')||document).querySelectorAll('button')).find(b=>!b.disabled&&b.textContent.startsWith(" + JSONObject.quote(label) + "))";
        waitFor(scenario, "!!" + action);
        web.evaluate(scenario, action + ".click()");
    }
    private void openSettings(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "!!document.querySelector('[data-android-settings]')");
        web.evaluate(scenario, "document.querySelector('[data-android-settings]').click()");
        waitFor(scenario, "!!document.querySelector('[data-testid=android-settings-account]')");
    }
    private void confirmLogout(ActivityScenario<MainActivity> scenario) throws Exception {
        waitFor(scenario, "!!Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>!b.disabled&&b.textContent==='Sign out')");
        web.evaluate(scenario, "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>!b.disabled&&b.textContent==='Sign out').click()");
    }
    private void fillPrompt(ActivityScenario<MainActivity> scenario, String value) throws Exception {
        waitFor(scenario, "!!document.querySelector('[role=dialog] input[type=text]')");
        web.evaluate(scenario, "(()=>{const input=document.querySelector('[role=dialog] input[type=text]');input.value=" + JSONObject.quote(value) + ";input.dispatchEvent(new Event('input',{bubbles:true}));input.form.requestSubmit()})()");
    }
    private void password(ActivityScenario<MainActivity> scenario, String previous, String next) throws Exception {
        click(scenario, "Change password"); fillPrompt(scenario, previous);
        waitFor(scenario, "document.querySelectorAll('[role=dialog] input[type=password]').length===2");
        web.evaluate(scenario, "document.querySelectorAll('[role=dialog] input[type=password]').forEach(i=>{i.value=" + JSONObject.quote(next) + ";i.dispatchEvent(new Event('input',{bubbles:true}))})");
        click(scenario, "Save");
    }
    private void login(ActivityScenario<MainActivity> scenario, String name, String password) throws Exception {
        waitFor(scenario, "!!document.querySelector('input[autocomplete=username]')");
        web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value=" + JSONObject.quote(name) + ";document.querySelector('input[type=password]').value=" + JSONObject.quote(password) + ";document.querySelector('input[type=password]').form.requestSubmit()");
        waitFor(scenario, "!!document.querySelector('[data-android-settings]')");
    }
    private void command(ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario, "window.__accountDone=false;window.__accountError=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s," + fields + "})).then(()=>window.__accountDone=true).catch(e=>window.__accountError=e.message)");
        waitFor(scenario, "window.__accountDone || !!window.__accountError");
        assertEquals(web.evaluate(scenario, "window.__accountError"), "true", web.evaluate(scenario, "window.__accountDone"));
    }
    private void observe(ActivityScenario<MainActivity> scenario) throws Exception {
        web.evaluate(scenario, "window.__accountTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__accountState=s),100)");
    }
    @Test public void httpAccountSettings() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsAccountSettings() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        String id = null, originalName = null, originalUsername = null;
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            login(scenario, "member", "android-test");
            String cookie = connection.cookieHeader(connection.getGeneration()); assertTrue(cookie != null);
            var initial = api(connection, origin, cookie, "/api/auth/state", "GET", null).getJSONObject("user");
            id = initial.getString("id"); originalName = initial.getString("display_name"); originalUsername = initial.getString("username");
            observe(scenario); waitFor(scenario, "window.__accountState?.ready");
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=member-track] [data-row-menu]')");
            web.evaluate(scenario, "document.querySelector('[data-browse-track-id=member-track] [data-row-menu]').click()"); click(scenario, "Available offline");
            var store = OfflineStore.shared(context); long generation = connection.getGeneration();
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (store.local("member-track", generation) == null) { assertTrue("Account fixture copy must become ready", System.nanoTime() < until); Thread.sleep(100); }
            command(scenario, "action:'queue',index:0,tracks:[{source:'local',id:'member-track',title:'member private song',artist:'member artist'}]");
            waitFor(scenario, "window.__accountState.playing"); command(scenario, "action:'pause'"); command(scenario, "action:'seek',positionMs:20000");
            waitFor(scenario, "!window.__accountState.playWhenReady && Math.abs(window.__accountState.positionMs-20000)<1000");
            String key = web.evaluate(scenario, "window.__accountState.items[0].key"), program = web.evaluate(scenario, "window.__accountState.programToken");
            web.evaluate(scenario, "window.__accountConnects=0;window.__accountEventReady=false;Capacitor.Plugins.SoundsibleEngine.addListener('engineEvent',e=>{if(e.event==='connect')window.__accountConnects++}).then(h=>{window.__accountEventHandle=h;window.__accountEventReady=true})");
            waitFor(scenario, "window.__accountEventReady");
            openSettings(scenario); click(scenario, "Change name"); click(scenario, "Cancel");
            assertEquals(originalName, api(connection, origin, cookie, "/api/auth/state", "GET", null).getJSONObject("user").getString("display_name"));
            click(scenario, "Change name"); fillPrompt(scenario, "Android account name");
            waitFor(scenario, "document.querySelector('[data-testid=android-settings-account]')?.textContent.includes('Android account name')");
            assertEquals("Android account name", store.state(generation).getJSONObject("user").getString("display_name"));
            click(scenario, "Change username"); fillPrompt(scenario, "owner");
            waitFor(scenario, "document.body.innerText.includes('That username is taken or not valid')");
            assertEquals(originalUsername, api(connection, origin, cookie, "/api/auth/state", "GET", null).getJSONObject("user").getString("username"));
            click(scenario, "Change username"); fillPrompt(scenario, "android-member");
            waitFor(scenario, "document.querySelector('[data-testid=android-settings-account]')?.textContent.includes('@android-member')");
            waitFor(scenario, "window.__accountConnects>=2");
            password(scenario, "fixture-wrong", "android-account-test");
            waitFor(scenario, "document.body.innerText.includes('Could not change it. Check that the current password is correct')");
            assertTrue("Rejected password change must retain the native cookie", cookie.equals(connection.cookieHeader(generation)));
            web.evaluate(scenario, "window.__accountConnects=0");
            password(scenario, "android-test", "android-account-test");
            until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (cookie.equals(connection.cookieHeader(generation))) { assertTrue("Password change must rotate the native session", System.nanoTime() < until); Thread.sleep(100); }
            String rotated = connection.cookieHeader(generation); assertTrue(rotated != null);
            String encrypted = context.getSharedPreferences("engine", android.content.Context.MODE_PRIVATE).getString("session", null);
            assertTrue("Rotated cookie must remain encrypted in native storage", encrypted != null && !encrypted.contains(rotated));
            var reloaded = new EngineConnection(context);
            assertTrue("Fresh native connection must decrypt the rotated Keystore session", rotated.equals(reloaded.cookieHeader(reloaded.getGeneration())));
            waitFor(scenario, "window.__accountConnects>0 && !document.body.innerText.includes('Live updates disconnected.')");
            web.evaluate(scenario, "window.__accountEventHandle.remove()");
            assertNotNull(store.local("member-track", generation));
            assertEquals(key, web.evaluate(scenario, "window.__accountState.items[0].key")); assertEquals(program, web.evaluate(scenario, "window.__accountState.programToken"));
            assertEquals("true", web.evaluate(scenario, "!window.__accountState.playWhenReady && Math.abs(window.__accountState.positionMs-20000)<1000"));
            scenario.recreate(); waitFor(scenario, "!!document.querySelector('[data-android-settings]')"); observe(scenario);
            waitFor(scenario, "window.__accountState?.items[0]?.key===" + key);
            assertTrue("Keystore session must survive Activity recreation", rotated.equals(connection.cookieHeader(generation)));
            assertNotNull(store.local("member-track", generation));
            openSettings(scenario); web.evaluate(scenario, "const toggle=document.querySelector('[data-setting=search-history] [role=switch]');if(toggle.getAttribute('aria-checked')==='true')toggle.click()");
            assertEquals("false", web.evaluate(scenario, "document.querySelector('[data-setting=search-history] [role=switch]').getAttribute('aria-checked')==='true'"));
            waitFor(scenario, "!document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').disabled");
            web.evaluate(scenario, "window.__accountLogout={headerDisabled:document.querySelector('header button')?.disabled,actionDisabled:document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').disabled};document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').click()"); confirmLogout(scenario);
            waitFor(scenario, "!!document.querySelector('input[autocomplete=username]')");
            assertTrue(connection.cookieHeader(connection.getGeneration()) == null); assertEquals(0, store.state(connection.getGeneration()).getJSONArray("items").length());
            login(scenario, "owner", "android-test"); openSettings(scenario);
            assertEquals("true", web.evaluate(scenario, "document.querySelector('[data-setting=search-history] [role=switch]').getAttribute('aria-checked')==='true'"));
            waitFor(scenario, "!document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').disabled");
            web.evaluate(scenario, "window.__accountLogout={headerDisabled:document.querySelector('header button')?.disabled,actionDisabled:document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').disabled};document.querySelector('[data-testid=android-settings-account] [data-setting=sign-out]').click()"); confirmLogout(scenario);
            login(scenario, "android-member", "android-account-test"); openSettings(scenario);
            assertEquals("false", web.evaluate(scenario, "document.querySelector('[data-setting=search-history] [role=switch]').getAttribute('aria-checked')==='true'"));
            assertEquals(id, api(connection, origin, connection.cookieHeader(connection.getGeneration()), "/api/auth/state", "GET", null).getJSONObject("user").getString("id"));
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
            web.evaluate(scenario, "clearInterval(window.__accountTimer)");
        } finally {
            try {
                if (id != null) {
                    String owner = ownerLogin(connection, origin);
                    api(connection, origin, owner, "/api/users/" + id, "PATCH", new JSONObject().put("display_name", originalName).put("username", originalUsername));
                    api(connection, origin, owner, "/api/users/" + id + "/password", "POST", new JSONObject().put("password", "android-test"));
                }
            } finally { connection.clearSession(true); }
        }
    }
}
