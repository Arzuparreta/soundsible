package com.soundsible.android

import android.content.ComponentName
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionError
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicInteger

@UnstableApi
class CarOfflineExpiryTest {
    @Test fun httpExpiredCookieLocalCopies() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsExpiredCookieLocalCopies() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        var visible: ActivityScenario<MainActivity>? = null
        var browser: MediaBrowser? = null
        val copyCount = AtomicInteger(-1)
        val copyTitle = AtomicReference<String>()
        fun <T> call(work: () -> ListenableFuture<T>): T {
            val selected = AtomicReference<ListenableFuture<T>>()
            instrumentation.runOnMainSync { selected.set(work()) }
            return selected.get().get(20, TimeUnit.SECONDS)
        }
        fun await(label: String, work: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < until) {
                val done = AtomicBoolean(); instrumentation.runOnMainSync { done.set(work()) }
                if (done.get()) return
                Thread.sleep(100)
            }
            fail(label)
        }
        fun unavailable(enabled: Boolean) {
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/connection-failure")
                .header("X-Android-Fixture", "isolated").post("{\"enabled\":$enabled,\"status\":503}".toRequestBody("application/json".toMediaType()))
                .build()).execute().use { assertEquals(200, it.code) }
        }
        try {
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()),
                emptyMap(), generation, "car-expiry-login", 15000).use {
                assertTrue(it.isSuccessful); connection.offline.bind(JSONObject(it.body!!.string()).getJSONObject("user"))
            }
            visible = ActivityScenario.launch(MainActivity::class.java)
            val listener = object : MediaBrowser.Listener {
                override fun onChildrenChanged(owner: MediaBrowser, parentId: String, itemCount: Int, params: androidx.media3.session.MediaLibraryService.LibraryParams?) {
                    if (parentId != ProgramCarLibrary.OFFLINE) return
                    copyCount.set(itemCount)
                    val future = owner.getChildren(parentId, 0, 200, params)
                    future.addListener({
                        val result = runCatching { future.get() }.getOrNull()
                        if (result?.resultCode == SessionResult.RESULT_SUCCESS) copyTitle.set(result.value!!.singleOrNull()?.mediaMetadata?.title?.toString())
                    }, { task -> task.run() })
                }
            }
            val active = call { MediaBrowser.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).setListener(listener).buildAsync() }
            browser = active
            val tracks = call { active.getChildren("all-tracks", 0, 200, null) }.value!!
            val online = tracks.single { it.mediaId == "soundsible:track:member-track" }
            instrumentation.runOnMainSync { active.setMediaItem(online); active.prepare(); active.play() }
            await("Online programme did not play", { active.isPlaying })
            connection.offline.prepare(generation, JSONArray().put(JSONObject().put("id", "member-track")
                .put("title", "member private song").put("artist", "member artist")), JSONObject())
            ContextCompat.startForegroundService(context, Intent(context, OfflineService::class.java))
            val copied = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
            while (connection.offline.local("member-track", generation) == null && System.nanoTime() < copied) Thread.sleep(100)
            assertNotNull("Complete offline copy missing", connection.offline.local("member-track", generation))
            visible!!.close(); visible = null
            connection.execute("/api/android-fixture/session-expiry", "POST", "{\"fixture\":\"isolated\",\"seconds\":1}".toRequestBody("application/json".toMediaType()),
                emptyMap(), generation, "car-expiry-cookie", 10000).use { assertEquals(200, it.code) }
            unavailable(true)
            val expires = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (connection.cookieHeader(generation) != null && System.nanoTime() < expires) Thread.sleep(100)
            assertNull("Cookie did not expire", connection.cookieHeader(generation))
            assertEquals(1, connection.offline.state(generation).getJSONArray("items").length())
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getItem(online.mediaId) }.resultCode)
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getChildren("all-tracks", 0, 200, null) }.resultCode)
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.getLibraryRoot(null) }.resultCode)
            val home = call { active.getChildren(ProgramCarLibrary.ROOT, 0, 200, null) }.value!!
            assertEquals(listOf(ProgramCarLibrary.OFFLINE), home.map { it.mediaId })
            val local = call { active.getChildren(ProgramCarLibrary.OFFLINE, 0, 200, null) }.value!!.single()
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.subscribe(ProgramCarLibrary.OFFLINE, null) }.resultCode)
            await("Local subscription initial count", { copyCount.get() == 1 && copyTitle.get() == "member private song" })
            assertNull("Offline B uses artwork placeholders", local.mediaMetadata.artworkUri)
            val pcm = AtomicBoolean()
            NativeProgramOutput.subscribe(generation) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }.use { capture ->
                instrumentation.runOnMainSync { active.setMediaItem(local); active.prepare(); active.play() }
                await("Expired-cookie local file did not play", {
                    active.isPlaying && active.currentMediaItem?.mediaId == "member-track" &&
                        active.currentMediaItem?.mediaMetadata?.extras?.getBoolean("offline") == true && pcm.get()
                })
                assertEquals(SessionResult.RESULT_SUCCESS, call { active.search("member private song", null) }.resultCode)
                val results = call { active.getSearchResult("member private song", 0, 200, null) }.value!!
                assertEquals(local.mediaId, results.single().mediaId)
                assertTrue(call { active.getSearchResult("owner private song", 0, 200, null) }.value!!.isEmpty())
                pcm.set(false)
                val voice = MediaItem.Builder().setRequestMetadata(MediaItem.RequestMetadata.Builder().setSearchQuery("member private song").build()).build()
                instrumentation.runOnMainSync { active.setMediaItem(voice); active.prepare(); active.play() }
                await("Offline acquired search did not play", { active.isPlaying && pcm.get() && active.currentMediaItem?.mediaMetadata?.extras?.getBoolean("offline") == true })
                assertFalse(capture.failed.get())
            }
            // Local cache changes must notify even with no cookie/network/WebView.
            connection.offline.updateMetadata(generation, JSONArray().put(JSONObject().put("id", "member-track").put("title", "Local copy changed")))
            await("Offline cache labels event missing", { copyCount.get() == 1 && copyTitle.get() == "Local copy changed" })
            connection.offline.remove(generation, JSONArray().put("member-track"))
            await("Offline removal event missing", { copyCount.get() == 0 })
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getLibraryRoot(null) }.resultCode)
            connection.clearSession(false)
            await("Logout retained programme", { active.mediaItemCount == 0 })
            assertEquals(0, connection.offline.state(connection.generation).getJSONArray("items").length())
            assertEquals(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, call { active.getLibraryRoot(null) }.resultCode)
        } finally {
            runCatching { unavailable(false) }
            browser?.let { selected -> instrumentation.runOnMainSync { selected.release() } }
            visible?.close()
            connection.clearSession(true)
        }
    }
}
