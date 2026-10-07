package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real acquisition, shared pool ownership, UI confirmation and single native program retirement. */
@RunWith(AndroidJUnit4.class)
public class FileDeletionTest {
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
        while (System.nanoTime() < until) { if ("true".equals(web.evaluate(scenario, condition))) return; Thread.sleep(100); }
        fail(condition + ": " + web.evaluate(scenario, "JSON.stringify(window.__deletionState)+' '+document.body.innerText"));
    }
    private JSONObject api(EngineConnection connection, String origin, String cookie, String path, String method, JSONObject body) throws Exception {
        var builder = new okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated");
        if (cookie != null) builder.header("Cookie", cookie);
        if (!method.equals("GET")) builder.method(method, body == null ? null : okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json")));
        try (var response = connection.getClient().newCall(builder.build()).execute()) {
            assertEquals(path + " status", 200, response.code()); return new JSONObject(response.body().string());
        }
    }
    private String ownerCookie(EngineConnection connection, String origin) throws Exception {
        var body = new JSONObject().put("username", "owner").put("password", "android-test");
        var request = new okhttp3.Request.Builder().url(origin + "/api/auth/login").post(okhttp3.RequestBody.create(body.toString(), okhttp3.MediaType.get("application/json"))).build();
        try (var response = connection.getClient().newCall(request).execute()) {
            assertEquals(200, response.code());
            for (String value : response.headers("Set-Cookie")) {
                var cookie = okhttp3.Cookie.parse(response.request().url(), value);
                if (cookie != null && cookie.name().equals("sb_session")) return cookie.name() + "=" + cookie.value();
            }
        }
        throw new AssertionError("Owner fixture login did not return a session");
    }
    private JSONObject acquired(EngineConnection connection, String origin, String cookie, String video) throws Exception {
        var rows = api(connection, origin, cookie, "/api/library", "GET", null).getJSONArray("tracks");
        for (int i = 0; i < rows.length(); i++) if (rows.getJSONObject(i).optString("youtube_id").equals(video)) return rows.getJSONObject(i);
        return null;
    }
    private JSONObject intake(String video, String title) throws Exception {
        return new JSONObject().put("items", new JSONArray().put(new JSONObject().put("source_type", "youtube_url")
            .put("song_str", "https://www.youtube.com/watch?v=" + video).put("video_id", video)
            .put("display_title", title).put("display_artist", "member artist")));
    }
    private JSONObject acquire(EngineConnection connection, String origin, String cookie, String video, String title) throws Exception {
        var reply = api(connection, origin, cookie, "/api/downloader/queue", "POST", intake(video, title));
        assertEquals(1, reply.getJSONArray("accepted").length());
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(50);
        JSONObject row;
        while ((row = acquired(connection, origin, cookie, video)) == null) { assertTrue("Acquisition must commit to its private library", System.nanoTime() < until); Thread.sleep(100); }
        return row;
    }
    private void click(ActivityScenario<MainActivity> scenario, String label) throws Exception {
        waitFor(scenario, "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ")");
        web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent===" + JSONObject.quote(label) + ").click()");
    }
    private void menu(ActivityScenario<MainActivity> scenario, String id) throws Exception {
        String selector = "[data-browse-track-id=" + JSONObject.quote(id) + "] [data-row-menu]";
        waitFor(scenario, "!!document.querySelector(" + JSONObject.quote(selector) + ")");
        web.evaluate(scenario, "document.querySelector(" + JSONObject.quote(selector) + ").click()");
    }
    private void command(ActivityScenario<MainActivity> scenario, String fields) throws Exception {
        web.evaluate(scenario, "window.__deletionDone=false;window.__deletionError=null;Capacitor.Plugins.SoundsiblePlayback.state().then(s=>Capacitor.Plugins.SoundsiblePlayback.command({...s," + fields + "})).then(()=>window.__deletionDone=true).catch(e=>window.__deletionError=e.message)");
        waitFor(scenario, "window.__deletionDone || !!window.__deletionError");
        assertEquals(web.evaluate(scenario, "window.__deletionError"), "true", web.evaluate(scenario, "window.__deletionDone"));
    }
    private void remove(ActivityScenario<MainActivity> scenario, String id) throws Exception {
        menu(scenario, id); click(scenario, "Delete from library");
        waitFor(scenario, "!!document.querySelector('[role=dialog]')"); click(scenario, "Delete");
        waitFor(scenario, "!document.querySelector('[data-browse-track-id=" + JSONObject.quote(id) + "]')");
    }
    private void cleanup(EngineConnection connection, String origin, String cookie) throws Exception {
        if (cookie == null) return;
        var jobs = api(connection, origin, cookie, "/api/downloader/queue/status", "GET", null).getJSONArray("queue");
        for (int i = 0; i < jobs.length(); i++) {
            var row = jobs.getJSONObject(i);
            if (java.util.Set.of("B1111111111", "D1111111111", "E1111111111").contains(row.optString("video_id"))) api(connection, origin, cookie, "/api/downloader/queue/" + row.getString("id"), "DELETE", null);
        }
        var rows = api(connection, origin, cookie, "/api/library", "GET", null).getJSONArray("tracks");
        for (int i = 0; i < rows.length(); i++) {
            var row = rows.getJSONObject(i);
            if (java.util.Set.of("B1111111111", "D1111111111", "E1111111111").contains(row.optString("youtube_id"))) api(connection, origin, cookie, "/api/library/tracks/" + row.getString("id"), "DELETE", null);
        }
    }
    @Test public void httpFileDeletion() throws Exception { run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void tlsFileDeletion() throws Exception { run(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void run(String origin) throws Exception {
        assumeNotNull(origin);
        var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        var connection = EngineConnection.shared(context); connection.clearSession(true);
        String member = null, owner = null;
        try (var scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!document.querySelector('[data-testid=android-library]')");
            member = connection.cookieHeader(connection.getGeneration());
            assertNotNull(member);
            api(connection, origin, member, "/__fixture/acquisition", "POST", new JSONObject().put("delaySeconds", 0).put("failNext", 0));
            var file = acquire(connection, origin, member, "B1111111111", "member saved song");
            String id = file.getString("id");
            owner = ownerCookie(connection, origin);
            assertTrue("Owner fixture login must not replace the native account", member.equals(connection.cookieHeader(connection.getGeneration())));
            var shared = acquire(connection, origin, owner, "B1111111111", "member saved song");
            assertEquals("Both accounts must share the actual acquired source", id, shared.getString("id"));
            String playlist = "Android source deletion";
            api(connection, origin, member, "/api/library/playlists", "POST", new JSONObject().put("name", playlist));
            api(connection, origin, member, "/api/library/playlist-edits/Android%20source%20deletion", "PATCH",
                new JSONObject().put("expected_track_ids", new JSONArray()).put("track_ids", new JSONArray().put(id).put("member-track").put(id)));
            click(scenario, "Playlists");
            waitFor(scenario, "!!Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='Android source deletion' && b.closest('[data-music-list-row]').querySelector('[data-row-detail]')?.textContent==='3 tracks')");
            click(scenario, "Songs");
            web.evaluate(scenario, "window.__deletionTimer=setInterval(()=>Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__deletionState=s),100)");
            waitFor(scenario, "window.__deletionState?.ready");
            menu(scenario, id); click(scenario, "Available offline");
            var store = OfflineStore.shared(context); long epoch = connection.getGeneration();
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (store.local(id, epoch) == null) { assertTrue("Explicit copy must become ready", System.nanoTime() < until); Thread.sleep(100); }
            var copied = store.local(id, epoch); assertNotNull(copied); assertTrue(copied.exists());
            assertEquals(new JSONArray().put(id).put("member-track").put(id).toString(), store.state(epoch).getJSONObject("playlists").getJSONArray(playlist).toString());
            command(scenario, "action:'queue',index:0,tracks:[{source:'preview',id:'B1111111111',title:'member saved song',artist:'member artist'},{source:'local',id:" + JSONObject.quote(id) + ",title:'Acquired one',artist:'member artist'},{source:'local',id:'member-track',title:'Other song',artist:'member artist'},{source:'local',id:" + JSONObject.quote(id) + ",title:'Acquired two',artist:'member artist'}]");
            waitFor(scenario, "window.__deletionState?.playing && window.__deletionState.items.length===4");
            command(scenario, "action:'pause'"); command(scenario, "action:'seek',positionMs:20000");
            waitFor(scenario, "!window.__deletionState.playWhenReady && Math.abs(window.__deletionState.positionMs-20000)<1000");
            String keys = web.evaluate(scenario, "JSON.stringify(window.__deletionState.items.map(i=>i.key))");
            String retained = web.evaluate(scenario, "JSON.stringify([window.__deletionState.items[0].key,window.__deletionState.items[2].key])");
            String program = web.evaluate(scenario, "window.__deletionState.programToken");
            web.evaluate(scenario, "window.__oldRetireRejected=null;Capacitor.Plugins.SoundsiblePlayback.command({generation:" + (epoch - 1) + ",action:'retireSource',id:" + JSONObject.quote(id) + "}).then(()=>window.__oldRetireRejected=false,()=>window.__oldRetireRejected=true)");
            waitFor(scenario, "window.__oldRetireRejected===true");
            menu(scenario, id); click(scenario, "Delete from library"); click(scenario, "Cancel");
            assertNotNull(acquired(connection, origin, member, "B1111111111"));
            assertNotNull(store.local(id, epoch)); assertEquals(keys, web.evaluate(scenario, "JSON.stringify(window.__deletionState.items.map(i=>i.key))"));
            remove(scenario, id);
            waitFor(scenario, "window.__deletionState.items.length===2 && window.__deletionState.items[0].source==='preview' && !window.__deletionState.playWhenReady && Math.abs(window.__deletionState.positionMs-20000)<1000");
            until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (store.state(epoch).getJSONArray("items").length() > 0) { assertTrue("Copy removal must finish", System.nanoTime() < until); Thread.sleep(100); }
            assertEquals(retained, web.evaluate(scenario, "JSON.stringify(window.__deletionState.items.map(i=>i.key))"));
            assertEquals(program, web.evaluate(scenario, "window.__deletionState.programToken"));
            assertNull(acquired(connection, origin, member, "B1111111111")); assertNull(store.local(id, epoch)); assertFalse(copied.exists());
            assertEquals(0, store.state(epoch).getJSONArray("items").length());
            assertEquals(new JSONArray().put("member-track").toString(), store.state(epoch).getJSONObject("playlists").getJSONArray(playlist).toString());
            assertNotNull("Other owner must retain membership", acquired(connection, origin, owner, "B1111111111"));
            try (var response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/api/static/stream/" + id).header("Cookie", owner).header("Range", "bytes=0-31").build()).execute()) {
                assertEquals("Member deletion must preserve shared audio", 206, response.code()); assertEquals(32, response.body().bytes().length);
            }
            waitFor(scenario, "!!document.querySelector('[data-browse-track-id=B1111111111] [data-row-main][aria-current=true]')");
            var current = acquire(connection, origin, member, "D1111111111", "Delete current file"); String currentId = current.getString("id");
            command(scenario, "action:'queue',index:0,tracks:[{source:'local',id:" + JSONObject.quote(currentId) + ",title:'Delete current file',artist:'member artist'},{source:'local',id:'member-track',title:'Successor',artist:'member artist'}]");
            waitFor(scenario, "window.__deletionState.id===" + JSONObject.quote(currentId) + " && window.__deletionState.playing");
            command(scenario, "action:'pause'"); command(scenario, "action:'seek',positionMs:20000");
            waitFor(scenario, "!window.__deletionState.playWhenReady && Math.abs(window.__deletionState.positionMs-20000)<1000");
            String successor = web.evaluate(scenario, "window.__deletionState.items[1].key");
            remove(scenario, currentId);
            waitFor(scenario, "window.__deletionState.items.length===1 && window.__deletionState.id==='member-track' && !window.__deletionState.playWhenReady");
            assertEquals(successor, web.evaluate(scenario, "window.__deletionState.items[0].key"));
            var last = acquire(connection, origin, member, "E1111111111", "Delete last file"); String lastId = last.getString("id");
            menu(scenario, lastId); click(scenario, "Available offline");
            until = System.nanoTime() + TimeUnit.SECONDS.toNanos(40);
            while (store.local(lastId, epoch) == null) { assertTrue("Last source copy must become ready", System.nanoTime() < until); Thread.sleep(100); }
            var lastCopy = store.local(lastId, epoch);
            command(scenario, "action:'queue',index:0,tracks:[{source:'local',id:" + JSONObject.quote(lastId) + ",title:'Delete last file',artist:'member artist'}]");
            waitFor(scenario, "window.__deletionState.id===" + JSONObject.quote(lastId) + " && window.__deletionState.playing");
            command(scenario, "action:'shuffle',enabled:true"); command(scenario, "action:'repeat',mode:2");
            api(connection, origin, member, "/api/library/tracks/" + lastId, "DELETE", null);
            waitFor(scenario, "!document.querySelector('[data-browse-track-id=" + JSONObject.quote(lastId) + "]')");
            assertNotNull("Remote deletion must retain the explicit device copy", store.local(lastId, epoch));
            assertTrue(lastCopy.exists());
            web.evaluate(scenario, "document.querySelector('[data-library-menu]').click()");
            click(scenario, "Only on this device");
            remove(scenario, lastId);
            waitFor(scenario, "window.__deletionState.items.length===0 && !window.__deletionState.playWhenReady && !window.__deletionState.shuffle && window.__deletionState.repeat===0 && window.__deletionState.state===1");
            assertNull(store.local(lastId, epoch)); assertFalse(lastCopy.exists());
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"));
            assertTrue("Retirement must preserve the selected account", member.equals(connection.cookieHeader(epoch)));
            web.evaluate(scenario, "clearInterval(window.__deletionTimer)");
        } finally {
            try {
                if (member != null) {
                    var snapshot = api(connection, origin, member, "/api/library", "GET", null);
                    var playlists = snapshot.getJSONObject("playlists");
                    if (playlists.has("Android source deletion")) api(connection, origin, member, "/api/library/playlist-edits/Android%20source%20deletion", "DELETE", new JSONObject().put("expected_track_ids", playlists.getJSONArray("Android source deletion")));
                }
                cleanup(connection, origin, member); cleanup(connection, origin, owner);
                api(connection, origin, null, "/__fixture/acquisition", "POST", new JSONObject().put("delaySeconds", 2).put("failNext", 0));
            } finally { connection.clearSession(true); }
        }
    }
}
