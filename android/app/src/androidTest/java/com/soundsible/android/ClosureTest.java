package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;
import android.content.ComponentName;
import android.content.Context;
import android.app.NotificationManager;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.MediaType;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Explicit close is local and authoritative, including unavailable engines and in-flight streams. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public class ClosureTest {
    @Test public void privateHttpClosure() throws Exception { verify(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void verifiedTlsClosure() throws Exception { verify(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private final StartupTest web = new StartupTest();
    private void waitFor(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if ("true".equals(web.evaluate(scenario, condition))) return;
            Thread.sleep(100);
        }
        fail(condition + ": " + web.evaluate(scenario, "JSON.stringify({closed:window.__closed,fresh:window.__fresh,phase:window.__phase,body:document.body.innerText})"));
    }
    private void control(EngineConnection connection, String origin, String action, String body) throws Exception {
        try (okhttp3.Response response = connection.getClient().newCall(new Request.Builder().url(origin + "/__fixture/" + action)
                .header("X-Android-Fixture", "isolated").post(RequestBody.create(body, MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    private void queue(ActivityScenario<MainActivity> scenario, long generation) throws Exception {
        web.evaluate(scenario, "window.__phase=null;window.__started=null;window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + generation + ",action:'queue',tracks:[{source:'local',id:'member-track',title:'close fixture',artist:'member'}],index:0}).then(s=>window.__started=s)");
        waitFor(scenario, "!!document.querySelector('[data-program-close]')");
    }
    private void nativeState(MediaController controller, boolean closed) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            if (closed) {
                assertEquals(0, controller.getMediaItemCount()); assertFalse(controller.isPlaying()); assertFalse(controller.getPlayWhenReady());
                assertEquals(Player.STATE_IDLE, controller.getPlaybackState()); assertFalse(controller.getShuffleModeEnabled());
                assertEquals(Player.REPEAT_MODE_OFF, controller.getRepeatMode()); assertNull(controller.getPlayerError());
                assertNull(controller.getMediaMetadata().title); assertNull(controller.getMediaMetadata().artworkUri);
            } else assertEquals(1, controller.getMediaItemCount());
        });
    }
    private void closed(ActivityScenario<MainActivity> scenario, MediaController controller, Context context, EngineConnection connection, long epoch, String cookie) throws Exception {
        NotificationManager notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        android.media.session.MediaController platform = null;
        for (android.service.notification.StatusBarNotification entry : notifications.getActiveNotifications()) {
            android.os.Parcelable token = entry.getNotification().extras.getParcelable(android.app.Notification.EXTRA_MEDIA_SESSION);
            if (token instanceof android.media.session.MediaSession.Token) platform = new android.media.session.MediaController(context, (android.media.session.MediaSession.Token) token);
        }
        web.evaluate(scenario, "document.querySelector('[data-program-close]').click()");
        waitFor(scenario, "!document.querySelector('[data-testid=android-program]') && !document.querySelector('[data-testid=program-queue]')");
        web.evaluate(scenario, "window.__closed=null;window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__closed=s)");
        waitFor(scenario, "window.__closed?.items.length===0 && window.__closed?.index===-1 && window.__closed?.id==='' && window.__closed?.title==='' && window.__closed?.durationMs===0 && window.__closed?.positionMs===0 && !window.__closed?.playWhenReady && !window.__closed?.shuffle && window.__closed?.repeat===0 && !window.__closed?.error");
        nativeState(controller, true);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (notifications.getActiveNotifications().length > 0 && System.nanoTime() < deadline) Thread.sleep(100);
        assertEquals("Close must remove media notification", 0, notifications.getActiveNotifications().length);
        if (platform != null) {
            long metadataDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (platform.getMetadata() != null && (platform.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE) != null || platform.getMetadata().getBitmap(android.media.MediaMetadata.METADATA_KEY_ALBUM_ART) != null) && System.nanoTime() < metadataDeadline) Thread.sleep(100);
            if (platform.getMetadata() != null) {
                assertNull("Closed platform session retains title", platform.getMetadata().getString(android.media.MediaMetadata.METADATA_KEY_TITLE));
                assertNull("Closed platform session retains artwork", platform.getMetadata().getBitmap(android.media.MediaMetadata.METADATA_KEY_ALBUM_ART));
            }
        }
        assertEquals(epoch, connection.getGeneration()); assertEquals(cookie, connection.cookieHeader(epoch));
        scenario.recreate();
        waitFor(scenario, "!!document.querySelector('[data-testid=android-configured]') && !document.documentElement.hasAttribute('data-booting') && !document.querySelector('[data-testid=android-program]') && !document.querySelector('input[type=password]')");
        nativeState(controller, true);
    }
    private void capture(String name) throws Exception {
        try (android.os.ParcelFileDescriptor command = InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand("screencap -p /sdcard/Download/" + name + ".png");
             java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(command)) { while (output.read() != -1) {} }
    }
    private void verify(String origin) throws Exception {
        assumeNotNull(origin);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        EngineConnection connection = EngineConnection.shared(context); connection.clearSession(true);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario);
            web.evaluate(scenario, "document.querySelector('input[type=url]').value=" + JSONObject.quote(origin) + ";document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()");
            waitFor(scenario, "!!document.querySelector('input[type=password]')");
            web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()");
            waitFor(scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
            long epoch = connection.getGeneration(); String cookie = connection.cookieHeader(epoch);
            AtomicReference<com.google.common.util.concurrent.ListenableFuture<MediaController>> future = new AtomicReference<>();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> future.set(new MediaController.Builder(context, new SessionToken(context, new ComponentName(context, PlaybackService.class))).buildAsync()));
            MediaController controller = future.get().get(10, TimeUnit.SECONDS);
            try {
                for (String phase : new String[] {"playing", "paused", "buffering", "error"}) {
                    if (phase.equals("buffering")) control(connection, origin, "stream-delay", "{\"enabled\":true}");
                    if (phase.equals("error")) control(connection, origin, "audio-failure", "{\"status\":503}");
                    queue(scenario, epoch);
                    if (phase.equals("playing") || phase.equals("paused")) {
                        waitFor(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__phase=s),window.__phase?.playing===true");
                    } else if (phase.equals("buffering")) {
                        waitFor(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__phase=s),window.__phase?.state===2 && !window.__phase?.playing");
                    } else waitFor(scenario, "!!document.querySelector('[data-program-retry]')");
                    if (phase.equals("playing")) {
                        waitFor(scenario, "!!window.__started?.programToken");
                        String previousProgram = web.evaluate(scenario, "window.__started.programToken");
                        queue(scenario, epoch);
                        waitFor(scenario, "!!window.__started?.programToken && window.__started.programToken!==" + previousProgram);
                        waitFor(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__phase=s),window.__phase?.playing===true");
                        web.evaluate(scenario, "window.__oldProgramRejected=null;window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + epoch + ",action:'stop',programToken:" + previousProgram + ",queueToken:window.__started.queueToken}).then(()=>window.__oldProgramRejected=false,()=>window.__oldProgramRejected=true)");
                        waitFor(scenario, "window.__oldProgramRejected===true"); nativeState(controller, false);
                    }
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { controller.setShuffleModeEnabled(true); controller.setRepeatMode(Player.REPEAT_MODE_ALL); if (phase.equals("paused")) controller.pause(); });
                    waitFor(scenario, "document.querySelector('[data-testid=android-program] select')?.value==='2'");
                    if (phase.equals("playing")) {
                        // Delayed close of a previous queue cannot close this program.
                        web.evaluate(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + epoch + ",action:'stop',queueToken:'stale'}).then(()=>window.__stale=false,()=>window.__stale=true)");
                        waitFor(scenario, "window.__stale===true"); nativeState(controller, false);
                        web.evaluate(scenario, "window.scrollTo(0,0)"); capture("soundsible-s2h-open");
                    }
                    AtomicReference<String> oldKey = new AtomicReference<>();
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> oldKey.set(ProgramQueue.INSTANCE.key(controller, 0)));
                    control(connection, origin, "connection-failure", "{\"enabled\":true}");
                    closed(scenario, controller, context, connection, epoch, cookie);
                    if (phase.equals("playing")) capture("soundsible-s2h-closed");
                    control(connection, origin, "connection-failure", "{\"enabled\":false}");
                    control(connection, origin, "stream-delay", "{\"enabled\":false}");
                    control(connection, origin, "audio-failure", "{\"status\":0}");
                    if (phase.equals("buffering")) { Thread.sleep(5200); nativeState(controller, true); }
                    waitFor(scenario, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Refresh' && !b.disabled)");
                    web.evaluate(scenario, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Refresh' && !b.disabled).click()");
                    waitFor(scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
                    // Adding to a closed program must not inherit the old Play/shuffle/repeat intention.
                    web.evaluate(scenario, "window.__fresh=null;window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.Capacitor.Plugins.SoundsiblePlayback.command({generation:" + epoch + ",action:'append',queueToken:s.queueToken,tracks:[{source:'local',id:'member-track',title:'fresh program'}]})).then(s=>window.__fresh=s)");
                    waitFor(scenario, "window.__fresh?.items.length===1 && !window.__fresh?.playWhenReady && !window.__fresh?.shuffle && window.__fresh?.repeat===0");
                    nativeState(controller, false);
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertNotEquals("New program must have new occurrences", oldKey.get(), ProgramQueue.INSTANCE.key(controller, 0)));
                    closed(scenario, controller, context, connection, epoch, cookie);
                }
                // An explicit library activation after all closures can start real playback again.
                waitFor(scenario, "!!Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song')");
                web.evaluate(scenario, "Array.from(document.querySelectorAll('[data-row-main]')).find(b=>b.textContent==='member private song').click()");
                waitFor(scenario, "window.Capacitor.Plugins.SoundsiblePlayback.state().then(s=>window.__last=s),window.__last?.playing===true");
                AtomicReference<String> taskKey = new AtomicReference<>();
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> taskKey.set(ProgramQueue.INSTANCE.key(controller, 0)));
                scenario.onActivity(activity -> activity.finishAndRemoveTask());
                Thread.sleep(1200);
                InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertTrue("Removing task must retain ongoing native playback", controller.isPlaying()));
                try (ActivityScenario<MainActivity> reopened = ActivityScenario.launch(MainActivity.class)) {
                    waitFor(reopened, "!document.documentElement.hasAttribute('data-booting') && !!document.querySelector('[data-program-close]')");
                    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> assertEquals(taskKey.get(), ProgramQueue.INSTANCE.key(controller, 0)));
                    closed(reopened, controller, context, connection, epoch, cookie);
                }
            } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> controller.release()); }
        } finally {
            control(connection, origin, "connection-failure", "{\"enabled\":false}"); control(connection, origin, "stream-delay", "{\"enabled\":false}");
            control(connection, origin, "audio-failure", "{\"status\":0}"); connection.clearSession(true);
        }
    }
}
