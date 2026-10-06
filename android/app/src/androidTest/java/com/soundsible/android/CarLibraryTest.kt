package com.soundsible.android

import android.content.ComponentName
import android.graphics.BitmapFactory
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.media3.session.LibraryResult
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ActivityScenario
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Real MediaBrowser/service/Core tree. Same-UID harness is not Android Auto host acceptance. */
@UnstableApi
class CarLibraryTest {
    @Test fun httpScopedBrowseAndPlay() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsScopedBrowseAndPlay() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        var browser: MediaBrowser? = null
        var visible: ActivityScenario<MainActivity>? = null
        fun <T> call(work: () -> ListenableFuture<T>): T {
            val future = AtomicReference<ListenableFuture<T>>()
            instrumentation.runOnMainSync { future.set(work()) }
            return future.get().get(20, TimeUnit.SECONDS)
        }
        fun await(work: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) {
                val result = AtomicBoolean(); instrumentation.runOnMainSync { result.set(work()) }
                if (result.get()) return
                Thread.sleep(100)
            }
            val detail = AtomicReference<String>()
            instrumentation.runOnMainSync {
                detail.set("id=${browser?.currentMediaItem?.mediaId}, playing=${browser?.isPlaying}, " +
                    "count=${browser?.mediaItemCount}, radio=${browser?.sessionExtras?.getBoolean("radioActive")}, " +
                    "phase=${browser?.sessionExtras?.getString("radioPhase")}, error=${browser?.playerError?.errorCode}")
            }
            fail("Car programme did not reach expected state: ${detail.get()}")
        }
        try {
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()), emptyMap(), generation, "car-login", 15000).use { assertTrue(it.isSuccessful); connection.offline.bind(JSONObject(it.body!!.string()).getJSONObject("user")) }
            visible = ActivityScenario.launch(MainActivity::class.java)
            val active = call { MediaBrowser.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).buildAsync() }
            browser = active
            val root = call { active.getLibraryRoot(null) }
            assertEquals(SessionResult.RESULT_SUCCESS, root.resultCode)
            assertEquals(ProgramCarLibrary.ROOT, root.value!!.mediaId)
            val home = call { active.getChildren(root.value!!.mediaId, 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, home.resultCode)
            assertTrue(home.value!!.any { it.mediaId == "all-tracks" && it.mediaMetadata.isBrowsable == true })
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.subscribe("all-tracks", null) }.resultCode)
            val tracks = call { active.getChildren("all-tracks", 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, tracks.resultCode)
            val song = tracks.value!!.single { it.mediaId == "soundsible:track:member-track" }
            assertEquals("member private song", song.mediaMetadata.title.toString())
            assertNull(song.localConfiguration)
            val cover = requireNotNull(song.mediaMetadata.artworkUri)
            assertEquals("content", cover.scheme)
            assertEquals(context.packageName + ".carart", cover.authority)
            assertFalse(cover.toString().contains(origin))
            context.contentResolver.openInputStream(cover)!!.use { input ->
                val image = requireNotNull(BitmapFactory.decodeStream(input))
                assertTrue(image.width <= ProgramArtwork.MAX_EDGE && image.height <= ProgramArtwork.MAX_EDGE)
                val pixel = image.getPixel(image.width / 2, image.height / 2)
                // The fixture is JPEG: decoding/re-encoding may round a channel.
                for ((actual, expected) in listOf(android.graphics.Color.red(pixel) to 0xc5,
                    android.graphics.Color.green(pixel) to 0x30, android.graphics.Color.blue(pixel) to 0x30)) {
                    assertTrue("Unexpected private cover colour", kotlin.math.abs(actual - expected) <= 2)
                }
                image.recycle()
            }
            instrumentation.runOnMainSync {
                try { active.getChildren("all-tracks", -1, 20, null); fail("Negative page accepted") }
                catch (_: IllegalArgumentException) { }
            }
            assertEquals(SessionError.ERROR_BAD_VALUE, call { active.getChildren("all-tracks", 0, 201, null) }.resultCode)
            assertEquals(SessionError.ERROR_BAD_VALUE, call { active.getItem("soundsible:track:owner-track") }.resultCode)
            val forged = MediaItem.Builder().setMediaId(song.mediaId).setUri("https://private.invalid/audio?token=synthetic")
                .setMediaMetadata(MediaMetadata.Builder().setTitle("Caller forged title").build()).build()
            val pcm = AtomicBoolean()
            NativeProgramOutput.subscribe(generation) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }.use { capture ->
                instrumentation.runOnMainSync { active.setMediaItem(forged); active.prepare(); active.play() }
                await { active.isPlaying && active.currentMediaItem?.mediaId == "member-track" && pcm.get() }
                instrumentation.runOnMainSync {
                    assertEquals("member private song", active.currentMediaItem!!.mediaMetadata.title.toString())
                    assertFalse(active.currentMediaItem!!.localConfiguration?.uri?.toString()?.contains("private.invalid") == true)
                    active.pause()
                }
                await { !active.playWhenReady }
                assertFalse(capture.failed.get())
            }
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.search("member private song", null) }.resultCode)
            val searched = call { active.getSearchResult("member private song", 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, searched.resultCode)
            assertEquals("soundsible:track:member-track", searched.value!!.single().mediaId)
            assertTrue(call { active.getSearchResult("owner private song", 0, 200, null) }.value!!.isEmpty())
            instrumentation.runOnMainSync { assertFalse(active.playWhenReady) }
            val voice = MediaItem.Builder().setMediaId("caller-search").setUri("https://private.invalid/forged")
                .setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("member private song").build()).build()
            pcm.set(false)
            NativeProgramOutput.subscribe(generation) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }.use { capture ->
                instrumentation.runOnMainSync { active.setMediaItem(voice); active.prepare(); active.play() }
                await { active.isPlaying && active.currentMediaItem?.mediaId == "member-track" && pcm.get() }
                instrumentation.runOnMainSync { active.pause() }
                await { !active.playWhenReady }
                assertFalse(capture.failed.get())
            }
            fun fixture(path: String, body: String) {
                connection.client.newCall(okhttp3.Request.Builder().url(origin + path).header("X-Android-Fixture", "isolated")
                    .header("Cookie", connection.cookieHeader(generation)!!).post(body.toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
            }
            fixture("/__fixture/car-collections", "{\"enabled\":true}")
            try {
                for (parent in listOf("playlists", "podcasts")) {
                    val first = call { active.getChildren(parent, 0, 200, null) }
                    val second = call { active.getChildren(parent, 1, 200, null) }
                    val last = call { active.getChildren(parent, 2, 200, null) }
                    for (result in listOf(first, second, last)) assertEquals(SessionResult.RESULT_SUCCESS, result.resultCode)
                    assertEquals(200, first.value!!.size); assertEquals(200, second.value!!.size)
                    assertTrue(last.value!!.size >= 5)
                    assertTrue(first.value!!.map { it.mediaId }.intersect(second.value!!.map { it.mediaId }.toSet()).isEmpty())
                    val legacy = call { active.getChildren(parent, 0, Int.MAX_VALUE, null) }
                    assertEquals(SessionResult.RESULT_SUCCESS, legacy.resultCode)
                    assertTrue(legacy.value!!.size >= 405)
                }
            } finally { fixture("/__fixture/car-collections", "{\"enabled\":false}") }
            fixture("/__fixture/podcast", "{\"acquire_episode\":true}")
            val podcasts = call { active.getChildren("podcasts", 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, podcasts.resultCode)
            assertTrue(podcasts.value!!.any { it.mediaId == "podcast:member-feed" && it.mediaMetadata.isBrowsable == true })
            val episodes = call { active.getChildren("podcast:member-feed", 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, episodes.resultCode)
            assertTrue("Acquired episode missing from feed", episodes.value!!.any { it.mediaId == "soundsible:track:member-podcast-acquired" })
            val episode = episodes.value!!.single { it.mediaId == "soundsible:track:member-podcast-acquired" }
            instrumentation.runOnMainSync { active.setMediaItem(episode); active.prepare(); active.play() }
            await { active.isPlaying && active.currentMediaItem?.mediaId == "member-podcast-acquired" }
            instrumentation.runOnMainSync { active.pause(); active.seekTo(120000) }
            await { !active.playWhenReady && kotlin.math.abs(active.currentPosition - 120000) < 1000 }
            instrumentation.runOnMainSync { active.setMediaItem(episode); active.prepare(); active.play() }
            await { active.isPlaying && active.currentPosition in 119000..125000 }
            fixture("/__fixture/radio-seed", "{}")
            val seeds = call { active.getChildren("radio", 0, 200, null) }
            assertEquals(SessionResult.RESULT_SUCCESS, seeds.resultCode)
            assertFalse(seeds.value!!.any { it.mediaId.contains("podcast-acquired") })
            val seed = seeds.value!!.single { it.mediaId == "soundsible:radio:member-track" }
            instrumentation.runOnMainSync { active.setMediaItem(seed); active.prepare(); active.play() }
            await { active.isPlaying && active.currentMediaItem?.mediaId == "member-track" && active.sessionExtras.getBoolean("radioActive") && active.mediaItemCount > 1 }
            // Explicit complete copies remain browsable/playable when the engine fails.
            connection.offline.prepare(generation, JSONArray().put(JSONObject().put("id", "member-track").put("title", "Offline member song").put("artist", "member artist")), JSONObject())
            androidx.core.content.ContextCompat.startForegroundService(context,
                android.content.Intent(context, OfflineService::class.java))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
            while (connection.offline.local("member-track", generation) == null && System.nanoTime() < deadline) Thread.sleep(100)
            assertNotNull("Offline copy did not finish: ${connection.offline.state(generation).getJSONArray("items")}",
                connection.offline.local("member-track", generation))
            fun failure(enabled: Boolean, status: Int = 503) {
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/connection-failure").header("X-Android-Fixture", "isolated")
                    .post("{\"enabled\":$enabled,\"status\":$status}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
            }
            failure(true)
            try {
                val offlineHome = call { active.getChildren(ProgramCarLibrary.ROOT, 0, 200, null) }
                assertEquals(SessionResult.RESULT_SUCCESS, offlineHome.resultCode)
                assertTrue(offlineHome.value!!.any { it.mediaId == ProgramCarLibrary.OFFLINE })
                val copies = call { active.getChildren(ProgramCarLibrary.OFFLINE, 0, 200, null) }
                assertEquals(SessionResult.RESULT_SUCCESS, copies.resultCode)
                val local = copies.value!!.single()
                context.contentResolver.openInputStream(local.mediaMetadata.artworkUri!!)!!.use { input -> assertNotNull(BitmapFactory.decodeStream(input)) }
                instrumentation.runOnMainSync { active.setMediaItem(local); active.prepare(); active.play() }
                await { active.isPlaying && active.currentMediaItem?.mediaId == "member-track" }
            } finally { failure(false) }
            for (id in (0 until 10).map { "member-radio-$it" } + "member-podcast-acquired") {
                connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "car-cleanup-$id", 15000).close()
            }
            // Keep the service/browser, remove WebView requests before the
            // controlled revocation so this assertion belongs to the car path.
            visible!!.close(); visible = null
            failure(true, 401)
            try {
                assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getChildren("all-tracks", 0, 200, null) }.resultCode)
                await { active.mediaItemCount == 0 }
                assertEquals(0, connection.offline.state(connection.generation).getJSONArray("items").length())
            } finally { failure(false) }
            await { active.mediaItemCount == 0 }
            try { context.contentResolver.openInputStream(cover)?.close(); fail("Expired account artwork opened") }
            catch (_: java.io.FileNotFoundException) { }
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getLibraryRoot(null) }.resultCode)
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getItem(song.mediaId) }.resultCode)
        } finally {
            browser?.let { active -> instrumentation.runOnMainSync { active.release() } }
            visible?.close()
            connection.clearSession(true)
        }
    }
}
