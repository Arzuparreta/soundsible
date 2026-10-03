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

/** Packaged Solid click -> native service -> real authenticated WAV. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public class PlaybackTest {
    private void waitFor(StartupTest web, ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if ("true".equals(web.evaluate(scenario, condition))) return;
            Thread.sleep(100);
        }
        fail("Condition failed: " + condition + ": " + web.evaluate(scenario, "document.body.innerText"));
    }
    @Test public void nativeProgramSurvivesActivityAndAcceptsMediaCommands() throws Exception {
        runProgram(InstrumentationRegistry.getArguments().getString("fixtureOrigin"));
    }
    @Test public void verifiedTlsProgram() throws Exception {
        runProgram(InstrumentationRegistry.getArguments().getString("tlsOrigin"));
    }
    private void audioFailure(EngineConnection connection, String origin, int status) throws Exception {
        try (okhttp3.Response response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/__fixture/audio-failure")
            .header("X-Android-Fixture", "isolated").post(okhttp3.RequestBody.create("{\"account\":\"member\",\"status\":" + status + "}", okhttp3.MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    private void runProgram(String origin) throws Exception {
        assumeNotNull(origin);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection connection = EngineConnection.shared(context);
        connection.clearSession(true);
        StartupTest web = new StartupTest();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario);
            web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(web, scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(web, scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent==='Playlists').click()");
            waitFor(web, scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist')");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member playlist').click()");
            waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-row-main]')).filter(b=>b.textContent==='member private song').length===2");
            web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).filter(b=>b.textContent==='member private song')[1].click()");
            waitFor(web, scenario, "!!document.querySelector('[data-testid=android-program]') && Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Pause')");
            assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio') || !!navigator.serviceWorker?.controller"));
            var future = new AtomicReference<com.google.common.util.concurrent.ListenableFuture<MediaController>>();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> future.set(new MediaController.Builder(context, new SessionToken(context, new ComponentName(context, PlaybackService.class))).buildAsync()));
            MediaController controller = future.get().get(10, TimeUnit.SECONDS);
            try {
                Thread.sleep(700);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                    assertTrue(controller.isPlaying());
                    assertEquals("member-track", controller.getCurrentMediaItem().mediaId);
                    assertEquals(2, controller.getMediaItemCount()); assertEquals(1, controller.getCurrentMediaItemIndex());
                    assertEquals("member private song", controller.getMediaMetadata().title.toString());
                    assertTrue(controller.getDuration() > 599000);
                    controller.seekTo(12000);
                });
                Thread.sleep(500);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertTrue(controller.getCurrentPosition() >= 12000); controller.pause(); });
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Play')");
                android.app.NotificationManager notifications = (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                android.media.session.MediaSession.Token token = null;
                for (android.service.notification.StatusBarNotification entry : notifications.getActiveNotifications()) {
                    if (entry.getNotification().extras.getParcelable(android.app.Notification.EXTRA_MEDIA_SESSION) instanceof android.media.session.MediaSession.Token) {
                        token = entry.getNotification().extras.getParcelable(android.app.Notification.EXTRA_MEDIA_SESSION);
                    }
                }
                assertNotNull("Native media notification missing", token);
                android.media.session.MediaController systemController = new android.media.session.MediaController(context, token);
                assertEquals("member private song", systemController.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE));
                systemController.getTransportControls().play();
                Thread.sleep(300);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue(controller.isPlaying()));
                // A competing Android media focus request must pause the native program.
                android.media.AudioManager audio = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                android.media.AudioManager.OnAudioFocusChangeListener focus = change -> {};
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertEquals(android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED,
                    audio.requestAudioFocus(focus, android.media.AudioManager.STREAM_MUSIC, android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)));
                Thread.sleep(500);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertFalse(controller.isPlaying()); audio.abandonAudioFocus(focus); controller.play(); });
                Thread.sleep(300);
                // Bridge modes belong to the service, not the Activity. Queue indices remain original.
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).find(b=>b.textContent==='Shuffle').click()");
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Shuffle' && b.getAttribute('aria-pressed')==='true' && !b.disabled)");
                web.evaluate(scenario, "const repeat=document.querySelector('[data-testid=android-program] select');repeat.value='2';repeat.dispatchEvent(new Event('change',{bubbles:true}))");
                waitFor(web, scenario, "document.querySelector('[data-testid=android-program] select')?.value==='2' && !document.querySelector('[data-testid=android-program] select')?.disabled");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__modes=s)");
                waitFor(web, scenario, "window.__modes?.shuffle===true && window.__modes?.repeat===2 && window.__modes?.queue.length===2 && window.__modes?.index===1 && window.__modes?.hasNext===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'repeat',mode:9}).then(()=>window.__invalid=false,()=>window.__invalid=true)");
                waitFor(web, scenario, "window.__invalid===true");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertTrue(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_ALL, controller.getRepeatMode()); });
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED);
                Thread.sleep(900);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertTrue(controller.isPlaying()); assertTrue(controller.getCurrentPosition() > 12500); });
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
                scenario.recreate();
                waitFor(web, scenario, "!!document.querySelector('[data-testid=android-program]') && Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Pause')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue(controller.getCurrentPosition() > 12500));
                // Do not capture the loader just because the hidden Solid subtree already exists.
                waitFor(web, scenario, "!document.documentElement.hasAttribute('data-booting') && !document.getElementById('startup-screen') && getComputedStyle(document.querySelector('[data-testid=android-program]')).visibility==='visible'");
                try (android.os.ParcelFileDescriptor command = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand("screencap -p /sdcard/Download/soundsible-s2-program.png");
                     java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(command)) { while (output.read() != -1) {} }
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__restored=s)");
                waitFor(web, scenario, "window.__restored?.shuffle===true && window.__restored?.repeat===2 && window.__restored?.index===1");
                // Restore sequential end semantics via the same asynchronous bridge.
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'shuffle',enabled:false}).then(()=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'repeat',mode:0})).then(s=>window.__sequential=s)");
                waitFor(web, scenario, "window.__sequential?.shuffle===false && window.__sequential?.repeat===0 && window.__sequential?.hasNext===false");
                // Ending is observed from native state, not a JS clock.
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.seekTo(599700));
                Thread.sleep(1200);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(Player.STATE_ENDED, controller.getPlaybackState()); assertFalse(controller.isPlaying()); });
                try (okhttp3.Response response = connection.execute("/api/android-fixture/audio-stats", "GET", null, java.util.Collections.emptyMap(), connection.getGeneration(), "audio-stats", 8000)) {
                    String stats = response.body().string(); assertTrue("Native streaming did not request a real byte range: " + stats, stats.contains("206"));
                }
                // Two occurrences of one file remain two queue entries, including OS next/previous.
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'queue',tracks:[{id:'member-track',title:'first occurrence',artist:'member'},{id:'member-track',title:'second occurrence',artist:'member'}],index:0}).then(()=>window.__queueAccepted=true)");
                waitFor(web, scenario, "window.__queueAccepted===true && Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Pause')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(2, controller.getMediaItemCount()); controller.seekToNextMediaItem(); });
                Thread.sleep(500);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getCurrentMediaItemIndex()); assertEquals("second occurrence", controller.getMediaMetadata().title.toString()); controller.seekToPreviousMediaItem(); });
                Thread.sleep(300);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertEquals(0, controller.getCurrentMediaItemIndex()));
                // S2d: service-owned edits target occurrences, not duplicate track ids.
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'queue',tracks:[{id:'member-track',title:'first occurrence',artist:'member'},{id:'member-track',title:'second occurrence',artist:'member'},{id:'member-track',title:'third occurrence',artist:'member'}],index:1}).then(()=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'shuffle',enabled:true})).then(()=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'repeat',mode:2})).then(s=>window.__beforeEdit=s)");
                waitFor(web, scenario, "window.__beforeEdit?.items.length===3 && new Set(window.__beforeEdit.items.map(i=>i.key)).size===3 && document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===3");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { controller.pause(); controller.seekTo(15000); });
                web.evaluate(scenario, "document.querySelector('[data-testid=program-queue] header button').click()");
                waitFor(web, scenario, "!!document.querySelector('[data-testid=program-queue] [data-queue-action=up]')");
                web.evaluate(scenario, "document.querySelectorAll('[data-testid=program-queue] [data-queue-action=up]')[2].click()");
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=program-queue] [data-row-main]')).map(b=>b.textContent).join('|')==='first occurrence|third occurrence|second occurrence' && !document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').disabled");
                waitFor(web, scenario, "(()=>{const rows=Array.from(document.querySelectorAll('[data-testid=program-queue] [data-queue-key]')).map(e=>e.getBoundingClientRect()).sort((a,b)=>a.top-b.top);return rows.length===3 && rows.every((r,i)=>!i || r.top>=rows[i-1].bottom-1)})()");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(2, controller.getCurrentMediaItemIndex()); assertEquals("second occurrence", controller.getMediaMetadata().title.toString()); assertTrue(controller.getCurrentPosition() >= 15000 && controller.getCurrentPosition() < 17000); assertFalse(controller.isPlaying()); assertTrue(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_ALL, controller.getRepeatMode()); });
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'remove',queueToken:window.__beforeEdit.queueToken,key:window.__beforeEdit.items[0].key,index:0}).then(()=>window.__staleRejected=false,()=>window.__staleRejected=true)");
                waitFor(web, scenario, "window.__staleRejected===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'remove',queueToken:s.queueToken,key:s.items[1].key,index:0})).then(()=>window.__wrongKeyRejected=false,()=>window.__wrongKeyRejected=true)");
                waitFor(web, scenario, "window.__wrongKeyRejected===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + (connection.getGeneration() - 1) + ",action:'remove',queueToken:s.queueToken,key:s.items[0].key,index:0})).then(()=>window.__oldAccountRejected=false,()=>window.__oldAccountRejected=true)");
                waitFor(web, scenario, "window.__oldAccountRejected===true");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertEquals(3, controller.getMediaItemCount()));
                web.evaluate(scenario, "(()=>{const queue=document.querySelector('[data-testid=program-queue]');queue.children[1].scrollTop=queue.children[1].scrollHeight;queue.scrollIntoView({block:'center',behavior:'instant'});window.__queuePainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__queuePainted=true))})()");
                waitFor(web, scenario, "(()=>{const pane=document.querySelector('[data-testid=program-queue]').children[1].getBoundingClientRect();const active=document.querySelector('[data-testid=program-queue] [data-row-main][aria-current=true]').closest('[data-queue-key]').getBoundingClientRect();return window.__queuePainted===true && pane.top>=0 && pane.bottom<=innerHeight && active.top>=pane.top-1 && active.bottom<=pane.bottom+1})()");
                try (android.os.ParcelFileDescriptor capture = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand("screencap -p /sdcard/Download/soundsible-s2-program.png");
                     java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(capture)) { while (output.read() != -1) {} }
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=program-queue] [data-row-main]')).find(b=>b.textContent==='third occurrence').click()");
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=program-queue] [data-row-main]')).some(b=>b.textContent==='third occurrence' && b.getAttribute('aria-current')==='true') && document.querySelector('[data-testid=android-program]').textContent.includes('Pause') && !document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').disabled");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getCurrentMediaItemIndex()); assertEquals("third occurrence", controller.getMediaMetadata().title.toString()); assertTrue(controller.getCurrentPosition() < 5000); controller.pause(); controller.seekTo(17000); });
                web.evaluate(scenario, "document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').click()");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===2 && !document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').disabled");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(0, controller.getCurrentMediaItemIndex()); assertEquals("third occurrence", controller.getMediaMetadata().title.toString()); assertTrue(controller.getCurrentPosition() >= 17000 && controller.getCurrentPosition() < 19000); assertFalse(controller.isPlaying()); });
                web.evaluate(scenario, "document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').click()");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===1 && !document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').disabled");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals("second occurrence", controller.getMediaMetadata().title.toString()); assertFalse(controller.isPlaying()); assertTrue(controller.getCurrentPosition() < 5000); });
                web.evaluate(scenario, "document.querySelector('[data-testid=program-queue] [data-queue-action=remove]').click()");
                waitFor(web, scenario, "!document.querySelector('[data-testid=program-queue]') && !document.querySelector('[data-testid=android-program]')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(0, controller.getMediaItemCount()); assertFalse(controller.isPlaying()); assertTrue(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_ALL, controller.getRepeatMode()); });
                // S2e: add from the real library menu without replacing the service's program.
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
                waitFor(web, scenario, "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add to queue')");
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add to queue').click()");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===1 && document.querySelector('[data-testid=android-program]').textContent.includes('Play')");
                web.evaluate(scenario, "window.__insertReady=false;window.__insertReadyTimer=setInterval(()=>window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>{if(s.state===3 && s.durationMs>=600000){window.__insertReady=true;clearInterval(window.__insertReadyTimer)}}),100)");
                waitFor(web, scenario, "window.__insertReady===true");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getMediaItemCount()); assertFalse(controller.getPlayWhenReady()); assertTrue(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_ALL, controller.getRepeatMode()); controller.seekTo(23000); });
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__beforeInsert=s)");
                waitFor(web, scenario, "window.__beforeInsert?.items.length===1");
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-library] [data-row-main]')).find(b=>b.textContent==='member private song').closest('[data-music-list-row]').querySelector('[data-row-menu]').click()");
                waitFor(web, scenario, "!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add after current')");
                web.evaluate(scenario, "window.__menuPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__menuPainted=true))");
                waitFor(web, scenario, "window.__menuPainted===true && Array.from(document.querySelectorAll('[role=dialog] button')).filter(b=>b.textContent==='Add after current'||b.textContent==='Add to queue').every(b=>{const r=b.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth})");
                try (android.os.ParcelFileDescriptor capture = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand("screencap -p /sdcard/Download/soundsible-s2e-menu.png");
                     java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(capture)) { while (output.read() != -1) {} }
                web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add after current').click()");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===2");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(0, controller.getCurrentMediaItemIndex()); assertFalse(controller.getPlayWhenReady()); assertTrue("Insertion retained seek: " + controller.getCurrentPosition(), controller.getCurrentPosition() >= 23000 && controller.getCurrentPosition() < 24000); });
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__inserted=s)");
                waitFor(web, scenario, "window.__inserted?.items.length===2 && window.__inserted.items[0].key===window.__beforeInsert.items[0].key && window.__inserted.items[0].id===window.__inserted.items[1].id && window.__inserted.items[0].key!==window.__inserted.items[1].key");
                // The same order token cannot authorize 'after current' once OS navigation changed the anchor.
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.seekTo(1, 27000));
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'insertAfter',queueToken:window.__inserted.queueToken,index:0,key:window.__inserted.items[0].key,tracks:[{id:'member-track'}]}).then(()=>window.__anchorRejected=false,()=>window.__anchorRejected=true)");
                waitFor(web, scenario, "window.__anchorRejected===true");
                // Invalid batches are atomic; enforce the remaining capacity on the service queue.
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'append',queueToken:window.__inserted.queueToken,tracks:[{id:'member-track'},{id:''}]}).then(()=>window.__batchRejected=false,()=>window.__batchRejected=true)");
                waitFor(web, scenario, "window.__batchRejected===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'append',queueToken:window.__inserted.queueToken,tracks:Array.from({length:999},()=>({id:'member-track'}))}).then(()=>window.__limitRejected=false,()=>window.__limitRejected=true)");
                waitFor(web, scenario, "window.__limitRejected===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'append',queueToken:window.__beforeInsert.queueToken,tracks:[{id:'member-track'}]}).then(()=>window.__insertOrderRejected=false,()=>window.__insertOrderRejected=true)");
                waitFor(web, scenario, "window.__insertOrderRejected===true");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + (connection.getGeneration()-1) + ",action:'append',queueToken:window.__inserted.queueToken,tracks:[{id:'member-track'}]}).then(()=>window.__insertAccountRejected=false,()=>window.__insertAccountRejected=true)");
                waitFor(web, scenario, "window.__insertAccountRejected===true");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(2, controller.getMediaItemCount()); assertEquals(1, controller.getCurrentMediaItemIndex()); assertTrue(controller.getCurrentPosition() >= 27000 && controller.getCurrentPosition() < 28000); controller.play(); });
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'append',queueToken:s.queueToken,tracks:[{id:'member-track',title:'appended',artist:'member'}]}))");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===3 && document.querySelector('[data-testid=android-program]').textContent.includes('Pause')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getCurrentMediaItemIndex()); assertEquals("appended", controller.getMediaItemAt(2).mediaMetadata.title.toString()); assertTrue(controller.getCurrentPosition() >= 27000); assertTrue(controller.getPlayWhenReady()); controller.pause(); });
                scenario.recreate();
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===3 && document.querySelector('[data-testid=android-program]').textContent.includes('Play')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getCurrentMediaItemIndex()); assertTrue(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_ALL, controller.getRepeatMode()); });
                // Insert in the middle of the visible order, preserving its existing successor/key.
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>{window.__middleBefore=s;return window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'insertAfter',queueToken:s.queueToken,index:s.index,key:s.items[s.index].key,tracks:[{id:'member-track',title:'inserted middle'}]})})");
                waitFor(web, scenario, "window.Capacitor && document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===4");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__middleAfter=s)");
                waitFor(web, scenario, "window.__middleAfter?.items.length===4 && window.__middleAfter.items[2].title==='inserted middle' && window.__middleAfter.items[3].key===window.__middleBefore.items[2].key && new Set(window.__middleAfter.items.map(i=>i.key)).size===4");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(1, controller.getCurrentMediaItemIndex()); assertFalse(controller.getPlayWhenReady()); });
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'stop'}).then(()=>window.Capacitor.Plugins.SoundsiblePlayback.state()).then(s=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'insertAfter',index:-1,key:'',queueToken:s.queueToken,tracks:[{id:'member-track',title:'empty after'}]}))");
                waitFor(web, scenario, "document.querySelectorAll('[data-testid=program-queue] [data-row-main]').length===1 && document.querySelector('[data-testid=android-program]').textContent.includes('empty after')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(0, controller.getCurrentMediaItemIndex()); assertFalse(controller.getPlayWhenReady()); assertTrue(controller.getCurrentPosition() < 1000); });
                // A new source failure is visible, and explicit play retries the same position/queue.
                audioFailure(connection, origin, 503);
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'queue',tracks:[{id:'member-track',title:'retry',artist:'member'}],index:0})");
                waitFor(web, scenario, "!!document.querySelector('[data-testid=android-program] [role=alert]')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertFalse(controller.isPlaying()); assertEquals(1, controller.getMediaItemCount()); });
                audioFailure(connection, origin, 0);
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).find(b=>b.textContent==='Play').click()");
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Pause')");
                audioFailure(connection, origin, 403);
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'queue',tracks:[{id:'member-track',title:'denied',artist:'member'}],index:0})");
                waitFor(web, scenario, "document.body.innerText.includes('Your account cannot access this resource.')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertFalse(controller.isPlaying()));
                audioFailure(connection, origin, 0);
                // Revoke the real session while a new audio source is in flight. 401 must leave login, not a playing queue.
                try (okhttp3.Response response = connection.getClient().newCall(new okhttp3.Request.Builder().url(origin + "/__fixture/revoke")
                    .header("X-Android-Fixture", "isolated").post(okhttp3.RequestBody.create("{\"account\":\"member\"}", okhttp3.MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'queue',tracks:[{id:'member-track',title:'revoked',artist:'member'}],index:0})");
                waitFor(web, scenario, "!!document.querySelector('input[type=password]') && !document.querySelector('[data-testid=android-program]')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertFalse(controller.isPlaying()); assertEquals(0, controller.getMediaItemCount()); });
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
                waitFor(web, scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song').click()");
                waitFor(web, scenario, "Array.from(document.querySelectorAll('[data-testid=android-program] button')).some(b=>b.textContent==='Pause')");
                web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'shuffle',enabled:true}).then(()=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + connection.getGeneration() + ",action:'repeat',mode:1})).then(()=>window.__logoutModes=true)");
                waitFor(web, scenario, "window.__logoutModes===true");
                // Account change clears queue before another identity can start a program.
                web.evaluate(scenario, "Array.from(document.querySelectorAll('header button')).find(b=>b.textContent==='Sign out').click()");
                waitFor(web, scenario, "!!document.querySelector('input[type=password]') && !document.querySelector('[data-testid=android-program]')");
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { assertEquals(0, controller.getMediaItemCount()); assertFalse(controller.getShuffleModeEnabled()); assertEquals(Player.REPEAT_MODE_OFF, controller.getRepeatMode()); });
            } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.release()); }
        } finally { connection.clearSession(true); }
    }
}
