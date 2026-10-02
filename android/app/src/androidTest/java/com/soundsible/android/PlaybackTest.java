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
