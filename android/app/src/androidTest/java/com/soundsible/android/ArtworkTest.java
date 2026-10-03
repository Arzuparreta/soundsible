package com.soundsible.android;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeNotNull;

import android.graphics.Bitmap;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.Collections;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real private covers, hostile responses and cancellation, with HTTP and verified TLS. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
@RunWith(AndroidJUnit4.class)
public class ArtworkTest {
    @Test public void privateHttpArtwork() throws Exception { verify(InstrumentationRegistry.getArguments().getString("fixtureOrigin")); }
    @Test public void verifiedTlsArtwork() throws Exception { verify(InstrumentationRegistry.getArguments().getString("tlsOrigin")); }
    private void login(EngineConnection connection, String account) throws Exception {
        try (Response response = connection.execute("/api/auth/login", "POST", RequestBody.create("{\"username\":\"" + account + "\",\"password\":\"android-test\"}", MediaType.get("application/json")),
                Collections.emptyMap(), connection.getGeneration(), "artwork-login", 8000)) { assertEquals(200, response.code()); }
    }
    private void mode(EngineConnection connection, String origin, String mode) throws Exception {
        try (Response response = connection.getClient().newCall(new Request.Builder().url(origin + "/__fixture/artwork")
                .header("X-Android-Fixture", "isolated").post(RequestBody.create("{\"mode\":\"" + mode + "\"}", MediaType.get("application/json"))).build()).execute()) { assertEquals(200, response.code()); }
    }
    private void fails(ListenableFuture<Bitmap> result) throws Exception {
        try { result.get(10, TimeUnit.SECONDS); fail("Artwork should be unavailable"); }
        catch (ExecutionException expected) { assertNotNull(expected.getCause()); }
    }
    static void assertColor(int expected, int actual) {
        // The engine's thumbnail encoder uses lossy compression; verify account colour with a small tolerance.
        for (int shift : new int[] {0, 8, 16}) assertTrue("Unexpected account artwork colour", Math.abs(((expected >> shift) & 255) - ((actual >> shift) & 255)) <= 3);
    }
    private void privateUnavailable(ListenableFuture<Bitmap> result, int privateColour) throws Exception {
        try {
            Bitmap placeholder = result.get(10, TimeUnit.SECONDS);
            int actual = placeholder.getPixel(placeholder.getWidth() / 2, placeholder.getHeight() / 2);
            boolean resemblesPrivate = true;
            for (int shift : new int[] {0, 8, 16}) resemblesPrivate &= Math.abs(((privateColour >> shift) & 255) - ((actual >> shift) & 255)) <= 3;
            assertFalse("Another account's private cover leaked", resemblesPrivate);
        } catch (ExecutionException expected) { assertNotNull(expected.getCause()); }
    }
    private void red(Bitmap image) { assertColor(0xffc53030, image.getPixel(image.getWidth() / 2, image.getHeight() / 2)); assertTrue(image.getWidth() <= 512 && image.getHeight() <= 512); }
    private void verify(String origin) throws Exception {
        assumeNotNull(origin);
        EngineConnection connection = EngineConnection.shared(InstrumentationRegistry.getInstrumentation().getTargetContext());
        connection.clearSession(true); connection.configure(origin); login(connection, "member");
        try (ProgramArtwork loader = new ProgramArtwork(connection)) {
            Uri member = ProgramArtwork.Companion.uri(connection.getGeneration(), "member-track");
            ListenableFuture<Bitmap> image = loader.loadBitmap(member);
            red(image.get(10, TimeUnit.SECONDS));
            assertSame("Duplicate requests share the last in-memory result", image, loader.loadBitmap(member));
            privateUnavailable(loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(), "owner-track")), 0xff2845b4);
            fails(loader.loadBitmap(Uri.parse("https://example.invalid/private.png")));
            fails(loader.loadBitmap(Uri.parse("soundsible-artwork://" + connection.getGeneration() + "/member-track?cookie=forbidden")));
            for (String failure : new String[] {"missing", "invalid", "large"}) {
                mode(connection, origin, failure);
                fails(loader.loadBitmap(member));
                assertNotNull("Image failure does not clear the native login", connection.cookieHeader(connection.getGeneration()));
            }
            mode(connection, origin, ""); red(loader.loadBitmap(member).get(10, TimeUnit.SECONDS));
            // Evict the single cached request before exercising cancellation of a real delayed fetch.
            privateUnavailable(loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(), "owner-track")), 0xff2845b4);
            mode(connection, origin, "slow");
            ListenableFuture<Bitmap> pending = loader.loadBitmap(member);
            Thread.sleep(200); connection.clearSession(false);
            assertTrue("Logout cancels pending private artwork", pending.isCancelled());
            fails(loader.loadBitmap(member));
            mode(connection, origin, ""); login(connection, "owner");
            Bitmap owner = loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(), "owner-track")).get(10, TimeUnit.SECONDS);
            assertColor(0xff2845b4, owner.getPixel(owner.getWidth() / 2, owner.getHeight() / 2));
            privateUnavailable(loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(), "member-track")), 0xffc53030);
            Thread.sleep(2200);
            assertTrue("Late previous-account response remains cancelled", pending.isCancelled());
            assertEquals(owner.getPixel(0, 0), loader.loadBitmap(ProgramArtwork.Companion.uri(connection.getGeneration(), "owner-track")).get(10, TimeUnit.SECONDS).getPixel(0, 0));
        } finally { mode(connection, origin, ""); connection.clearSession(true); }
    }
}
