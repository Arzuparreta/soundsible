package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;

import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import io.socket.client.IO;
import io.socket.client.Socket;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Native transport against scripts/android_fixture.py's real account/library/socket routes. */
@RunWith(AndroidJUnit4.class)
public class ConnectionTest {
    private String origin() {
        String value = InstrumentationRegistry.getArguments().getString("fixtureOrigin");
        assumeNotNull(value);
        return value;
    }
    private Response request(EngineConnection connection, String path, String method, String body) throws Exception {
        return connection.execute(path, method, body == null ? null : RequestBody.create(body, MediaType.get("application/json")),
            Collections.emptyMap(), connection.getGeneration(), "test-" + System.nanoTime(), 8000);
    }
    private void signIn(EngineConnection c, String name) throws Exception {
        try (Response response = request(c, "/api/auth/login", "POST", "{\"username\":\"" + name + "\",\"password\":\"android-test\"}")) {
            assertEquals(200, response.code());
        }
    }
    @Test public void accountCookieArtworkRolesSocketsRevocationAndSwitch() throws Exception {
        String server = origin();
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection c = new EngineConnection(context);
        c.clearSession(true);
        Socket socket = null;
        try {
            assertFalse(android.security.NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("example.com"));
            assertTrue(android.security.NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(EngineConnection.PRIVATE_ALIAS));
            c.configure(server);
            try (Response response = request(c, "/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"wrong\"}")) { assertEquals(401, response.code()); }
            signIn(c, "member");
            try (Response response = request(c, "/api/auth/state", "GET", null)) { assertEquals("member", new JSONObject(response.body().string()).getJSONObject("user").getString("username")); }
            try (Response response = request(c, "/api/library", "GET", null)) {
                assertEquals(200, response.code());
                String payload = response.body().string();
                assertTrue(payload.contains("member private song")); assertFalse(payload.contains("owner private song"));
            }
            try (Response response = request(c, "/api/static/cover/member-track?size=thumb", "GET", null)) { assertEquals(200, response.code()); assertTrue(response.header("Content-Type").startsWith("image/")); }
            byte[] ownCover;
            try (Response response = request(c, "/api/static/cover/member-track?size=thumb", "GET", null)) { ownCover = response.body().bytes(); }
            try (Response response = request(c, "/api/static/cover/owner-track?size=thumb", "GET", null)) {
                assertFalse("Other account artwork leaked", java.util.Arrays.equals(ownCover, response.body().bytes()));
            }
            try (Response response = request(c, "/api/users", "GET", null)) { assertEquals(403, response.code()); }
            // Reconstructing the native connection must restore the encrypted session.
            EngineConnection reopened = new EngineConnection(context);
            try (Response response = request(reopened, "/api/auth/me", "GET", null)) { assertEquals(200, response.code()); }
            String persisted = context.getSharedPreferences("engine", Context.MODE_PRIVATE).getString("session", "");
            assertFalse(persisted.contains("sb_session")); assertFalse(persisted.contains("android-test"));

            IO.Options options = new IO.Options();
            options.forceNew = true; options.callFactory = c.getClient(); options.webSocketFactory = c.getClient();
            options.extraHeaders = Collections.singletonMap("Cookie", Collections.singletonList(c.cookieHeader(c.getGeneration())));
            CountDownLatch connected = new CountDownLatch(1), updated = new CountDownLatch(1);
            socket = IO.socket(server, options);
            socket.on(Socket.EVENT_CONNECT, args -> connected.countDown());
            socket.on("library_updated", args -> updated.countDown());
            socket.connect(); assertTrue("Real Socket.IO handshake failed", connected.await(15, TimeUnit.SECONDS));
            control(server, "event", "owner");
            assertFalse("Another account's event leaked", updated.await(1, TimeUnit.SECONDS));
            control(server, "event", "member");
            assertTrue("Account event missing", updated.await(8, TimeUnit.SECONDS));
            control(server, "revoke", "member");
            try (Response response = request(c, "/api/library", "GET", null)) { assertEquals(401, response.code()); }
            socket.off(); socket.disconnect(); socket = null;

            c.clearSession(false); signIn(c, "owner");
            try (Response response = request(c, "/api/users", "GET", null)) { assertEquals(200, response.code()); }
            try (Response response = request(c, "/api/library", "GET", null)) { assertTrue(response.body().string().contains("owner private song")); }
            try (Response response = request(c, "/api/android-fixture/redirect", "GET", null)) { assertEquals(302, response.code()); }
            java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor();
            java.util.concurrent.Future<Integer> delayed = worker.submit(() -> {
                try (Response response = request(c, "/api/android-fixture/slow", "GET", null)) { return response.code(); }
            });
            Thread.sleep(300);
            c.configure(server);
            try { delayed.get(8, TimeUnit.SECONDS); fail("In-flight old account response accepted"); }
            catch (java.util.concurrent.ExecutionException expected) { assertTrue(expected.getCause() instanceof java.io.IOException || expected.getCause() instanceof IllegalArgumentException); }
            finally { worker.shutdownNow(); }
            var previousClient = c.getClient();
            assertSame("REST calls must reuse the current transport", previousClient, c.getClient());
            try (Response response = request(c, "/api/library", "GET", null)) { assertEquals(200, response.code()); }
            assertTrue("Closed response must return a connection to the shared pool", previousClient.connectionPool().idleConnectionCount() > 0);
            long previous = c.getGeneration();
            c.configure(server);
            assertNotSame("Reset must retire the old transport", previousClient, c.getClient());
            assertEquals(0, previousClient.connectionPool().idleConnectionCount());
            try { c.execute("/api/library", "GET", null, Collections.emptyMap(), previous, "old", 1000); fail("Old generation accepted"); }
            catch (IllegalArgumentException expected) { }
            try (Response response = request(c, "/api/auth/logout", "POST", "{}")) { assertEquals(200, response.code()); }
            try (Response response = request(c, "/api/library", "GET", null)) { assertEquals(401, response.code()); }
            try { c.configure("http://example.com"); fail("Public HTTP accepted"); } catch (IllegalArgumentException expected) { }
            try { c.configure(server + "/player/"); fail("Remote page accepted as origin"); } catch (IllegalArgumentException expected) { }
            try { c.configure("https://user:secret@example.com"); fail("Credentials in URL accepted"); } catch (IllegalArgumentException expected) { }
        } finally { if (socket != null) { socket.off(); socket.disconnect(); } c.clearSession(true); }
    }
    @Test public void passwordlessSessionAndServerSwitch() throws Exception {
        String server = origin();
        String passwordless = InstrumentationRegistry.getArguments().getString("passwordlessOrigin");
        assumeNotNull(passwordless);
        EngineConnection c = new EngineConnection(InstrumentationRegistry.getInstrumentation().getTargetContext());
        c.clearSession(true);
        try {
            c.configure(server); signIn(c, "member");
            c.configure(passwordless);
            try (Response response = request(c, "/api/auth/state", "GET", null)) {
                JSONObject state = new JSONObject(response.body().string()); assertFalse(state.getBoolean("requires_login"));
                assertEquals("owner", state.getJSONObject("user").getString("username"));
            }
            try (Response response = request(c, "/api/auth/login", "POST", "{}")) { assertEquals(200, response.code()); }
            assertNotNull(c.cookieHeader(c.getGeneration()));
            try (Response response = request(c, "/api/library", "GET", null)) { assertTrue(response.body().string().contains("owner private song")); }
            c.configure(server);
            try (Response response = request(c, "/api/library", "GET", null)) { assertEquals(401, response.code()); }
            c.configure(server.replace("http://", "https://"));
            try { request(c, "/api/auth/state", "GET", null).close(); fail("Plain HTTP server accepted as TLS"); }
            catch (java.io.IOException expected) { }
        } finally { c.clearSession(true); }
    }
    @Test public void verifiedTlsAccountCookieArtworkAndSocket() throws Exception {
        String server = InstrumentationRegistry.getArguments().getString("tlsOrigin"); assumeNotNull(server);
        EngineConnection c = new EngineConnection(InstrumentationRegistry.getInstrumentation().getTargetContext());
        c.clearSession(true);
        Socket socket = null;
        try {
            c.configure(server); signIn(c, "member");
            try (Response response = request(c, "/api/auth/state", "GET", null)) {
                assertEquals("member", new JSONObject(response.body().string()).getJSONObject("user").getString("username"));
            }
            try (Response response = request(c, "/api/library", "GET", null)) {
                assertEquals(200, response.code()); assertTrue(response.body().string().contains("member private song"));
            }
            try (Response response = request(c, "/api/static/cover/member-track?size=thumb", "GET", null)) { assertEquals(200, response.code()); }
            IO.Options options = new IO.Options(); options.forceNew = true;
            options.callFactory = c.getClient(); options.webSocketFactory = c.getClient();
            options.extraHeaders = Collections.singletonMap("Cookie", Collections.singletonList(c.cookieHeader(c.getGeneration())));
            CountDownLatch connected = new CountDownLatch(1);
            socket = IO.socket(server, options); socket.on(Socket.EVENT_CONNECT, args -> connected.countDown()); socket.connect();
            assertTrue("Verified TLS socket handshake failed", connected.await(15, TimeUnit.SECONDS));
            try (Response response = request(c, "/api/auth/logout", "POST", "{}")) { assertEquals(200, response.code()); }
            try (Response response = request(c, "/api/library", "GET", null)) { assertEquals(401, response.code()); }
        } finally { if (socket != null) { socket.off(); socket.disconnect(); } c.clearSession(true); }
    }
    private void control(String server, String action, String account) throws Exception {
        // Test-only control uses a separate credential-free client.
        try (Response response = new EngineConnection(InstrumentationRegistry.getInstrumentation().getTargetContext()).getClient().newCall(new okhttp3.Request.Builder()
            .url(server + "/__fixture/" + action).header("X-Android-Fixture", "isolated")
            .post(RequestBody.create("{\"account\":\"" + account + "\"}", MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    @Test public void packagedLibraryLoginAndAccountChange() throws Exception {
        String server = origin();
        EngineConnection cleanup = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());
        cleanup.clearSession(true);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            StartupTest web = new StartupTest(); web.awaitReady(scenario);
            web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(server) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            awaitText(web, scenario, "Sign in");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            awaitText(web, scenario, "member private song");
            awaitText(web, scenario, "member saved song");
            assertEquals("false", web.evaluate(scenario, "document.body.innerText.includes('owner saved song')"));
            assertEquals("false", web.evaluate(scenario, "document.body.innerText.includes('owner private song')"));
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio') || !!navigator.serviceWorker?.controller"));
            awaitText(web, scenario, "Development build:");
            String coverReady = "(()=>{const row=Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')?.closest('[data-music-list-row]');const cover=row?.querySelector('[data-row-cover]');window.__fixtureCoverSource=cover?/url\\(\"([^\"]+)\"\\)/.exec(getComputedStyle(cover).backgroundImage)?.[1]:null;return !!window.__fixtureCoverSource})()";
            long sourceDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (!"true".equals(web.evaluate(scenario, coverReady)) && System.nanoTime() < sourceDeadline) Thread.sleep(100);
            assertEquals("Member track cover source missing", "true", web.evaluate(scenario, "!!window.__fixtureCoverSource"));
            web.evaluate(scenario, "window.__fixtureCoverLoaded=false;const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,1,1);const pixel=ctx.getImageData(0,0,1,1).data;window.__fixtureCoverLoaded=pixel[0]>pixel[1]*2};image.src=window.__fixtureCoverSource");
            long coverDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (!"true".equals(web.evaluate(scenario, "window.__fixtureCoverLoaded===true")) && System.nanoTime() < coverDeadline) Thread.sleep(100);
            assertEquals("Authenticated WebView cover did not load: " + web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).map(b=>b.textContent).join(',')"), "true", web.evaluate(scenario, "window.__fixtureCoverLoaded===true"));
            try (android.os.ParcelFileDescriptor command = InstrumentationRegistry.getInstrumentation().getUiAutomation()
                    .executeShellCommand("screencap -p /sdcard/Download/soundsible-s1-library.png");
                 java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(command)) {
                while (output.read() != -1) { /* wait for screenshot completion */ }
            }
            web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Albums').click()");
            awaitText(web, scenario, "member album");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='member album').click()");
            awaitText(web, scenario, "member private song");
            control(server, "append", "member"); awaitText(web, scenario, "member event song");
            scenario.recreate(); awaitText(web, scenario, "member private song");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Sign out').click()");
            awaitText(web, scenario, "Sign in");
            assertEquals("false", web.evaluate(scenario, "document.body.innerText.includes('member private song')"));
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='owner';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            awaitText(web, scenario, "owner private song");
            assertEquals("false", web.evaluate(scenario, "document.body.innerText.includes('member private song')"));
        } finally { cleanup.clearSession(true); }
    }
    private void awaitText(StartupTest web, ActivityScenario<MainActivity> scenario, String text) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if ("true".equals(web.evaluate(scenario, "document.body.innerText.includes(" + JSONObject.quote(text) + ")"))) return;
            Thread.sleep(200);
        }
        fail("Missing " + text + ": " + web.evaluate(scenario, "document.body.innerText"));
    }
}
