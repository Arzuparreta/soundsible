package com.soundsible.android

import android.content.ComponentName
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.SessionToken
import androidx.media3.session.SessionResult
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Actual Core events must refresh car subscribers after the WebView is destroyed. */
@UnstableApi
class CarEventsTest {
    @Test fun httpBackgroundSubscriptions() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsBackgroundSubscriptions() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        var visible: ActivityScenario<MainActivity>? = null
        var browser: MediaBrowser? = null
        val title = AtomicReference<String>()
        val playlistCount = AtomicInteger(-1)
        val copyCount = AtomicInteger(-1)
        val changes = AtomicInteger()
        val pcm = AtomicBoolean()
        fun <T> call(work: () -> ListenableFuture<T>): T {
            val selected = AtomicReference<ListenableFuture<T>>()
            instrumentation.runOnMainSync { selected.set(work()) }
            return selected.get().get(20, TimeUnit.SECONDS)
        }
        fun await(label: String, condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < until) {
                val done = AtomicBoolean(); instrumentation.runOnMainSync { done.set(condition()) }
                if (done.get()) return
                Thread.sleep(100)
            }
            fail("$label: title=${title.get()}, playlists=${playlistCount.get()}, changes=${changes.get()}")
        }
        fun request(path: String, method: String, body: String?) {
            connection.execute(path, method, body?.toRequestBody("application/json".toMediaType()), emptyMap(),
                generation, "car-events-" + System.nanoTime(), 15000).use { assertEquals(200, it.code) }
        }
        fun delayStreams(enabled: Boolean) {
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/stream-delay")
                .header("X-Android-Fixture", "isolated").post("{\"enabled\":$enabled}".toRequestBody("application/json".toMediaType()))
                .build()).execute().use { assertEquals(200, it.code) }
        }
        fun socketNetwork(enabled: Boolean? = null): JSONObject {
            return connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/socket-network")
                .header("X-Android-Fixture", "isolated").post((if (enabled == null) "{}" else "{\"enabled\":$enabled}").toRequestBody("application/json".toMediaType()))
                .build()).execute().use {
                    assertEquals(200, it.code)
                    val state = JSONObject(it.body!!.string())
                    if (enabled == true) assertTrue("Fixture closed no socket: $state", state.getInt("before") > 0)
                    state
                }
        }
        fun socketTiming(enabled: Boolean) {
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/socket-timing")
                .header("X-Android-Fixture", "isolated").post("{\"enabled\":$enabled}".toRequestBody("application/json".toMediaType()))
                .build()).execute().use { assertEquals(200, it.code) }
        }
        try {
            socketTiming(true)
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()),
                emptyMap(), generation, "car-events-login", 15000).use {
                assertTrue(it.isSuccessful); connection.offline.bind(JSONObject(it.body!!.string()).getJSONObject("user"))
            }
            visible = ActivityScenario.launch(MainActivity::class.java)
            val listener = object : MediaBrowser.Listener {
                override fun onChildrenChanged(owner: MediaBrowser, parentId: String, itemCount: Int, params: LibraryParams?) {
                    changes.incrementAndGet()
                    if (parentId == "playlists") playlistCount.set(itemCount)
                    if (parentId == ProgramCarLibrary.OFFLINE) copyCount.set(itemCount)
                    if (parentId == "all-tracks") {
                        val future = owner.getChildren(parentId, 0, 200, params)
                        future.addListener({
                            val result = runCatching { future.get() }.getOrNull()
                            if (result?.resultCode == SessionResult.RESULT_SUCCESS) {
                                title.set(result.value!!.firstOrNull { it.mediaId == "soundsible:track:member-track" }?.mediaMetadata?.title?.toString())
                            }
                        }, { task -> task.run() })
                    }
                }
            }
            val active = call { MediaBrowser.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java))).setListener(listener).buildAsync() }
            browser = active
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.subscribe("all-tracks", null) }.resultCode)
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.subscribe("playlists", null) }.resultCode)
            assertEquals(SessionResult.RESULT_SUCCESS, call { active.subscribe(ProgramCarLibrary.OFFLINE, null) }.resultCode)
            await("Initial subscription", { title.get() == "member private song" && playlistCount.get() >= 0 })
            val initialPlaylists = playlistCount.get()
            val children = call { active.getChildren("all-tracks", 0, 200, null) }.value!!
            val song = children.single { it.mediaId == "soundsible:track:member-track" }
            NativeProgramOutput.subscribe(generation) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }.use { capture ->
                instrumentation.runOnMainSync { active.setMediaItem(song); active.prepare(); active.play() }
                await("Programme playing", { active.isPlaying && pcm.get() })
                val key = AtomicReference<String>()
                instrumentation.runOnMainSync { key.set(active.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY)) }
                delayStreams(true)
                connection.offline.prepare(generation, org.json.JSONArray().put(JSONObject().put("id", "member-track")
                    .put("title", "member private song")), JSONObject())
                androidx.core.content.ContextCompat.startForegroundService(context, android.content.Intent(context, OfflineService::class.java))
                visible!!.close(); visible = null
                await("Copy completed after Activity destruction", { copyCount.get() == 1 })
                delayStreams(false)
                connection.offline.remove(generation, org.json.JSONArray().put("member-track"))
                await("Native copy removal", { copyCount.get() == 0 })
                // All subsequent refreshes come from the native subscription owner.
                request("/api/library/track-labels/member-track/metadata", "POST", "{\"title\":\"Car background title\"}")
                await("Background labels event", { title.get() == "Car background title" })
                request("/api/library/playlists", "POST", "{\"name\":\"Car background\"}")
                await("Background playlist added", { playlistCount.get() == initialPlaylists + 1 })
                request("/api/library/playlists/Car%20background", "DELETE", null)
                await("Background playlist removed", { playlistCount.get() == initialPlaylists })
                socketNetwork(true)
                Thread.sleep(500) // Drain notifications sent before the transport was closed.
                request("/api/library/track-labels/member-track/metadata", "POST", "{\"title\":\"Car reconnect title\"}")
                val retryUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                while (socketNetwork().getInt("blocked") == 0 && System.nanoTime() < retryUntil) Thread.sleep(100)
                assertTrue("Fixture rejected no reconnect", socketNetwork().getInt("blocked") > 0)
                assertEquals("Disconnected subscription delivered new metadata", "Car background title", title.get())
                socketNetwork(false)
                await("Native socket reconnected and refreshed missed labels", { title.get() == "Car reconnect title" })
                pcm.set(false)
                await("Programme retained", {
                    active.isPlaying && pcm.get() && active.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY) == key.get()
                })
                assertFalse(capture.failed.get())
                assertEquals(SessionResult.RESULT_SUCCESS, call { active.unsubscribe("all-tracks") }.resultCode)
                assertEquals(SessionResult.RESULT_SUCCESS, call { active.unsubscribe("playlists") }.resultCode)
                assertEquals(SessionResult.RESULT_SUCCESS, call { active.unsubscribe(ProgramCarLibrary.OFFLINE) }.resultCode)
                Thread.sleep(500)
                val stopped = changes.get()
                request("/api/library/track-labels/member-track/metadata", "POST", "{\"title\":\"member private song\"}")
                Thread.sleep(750)
                assertEquals("Unsubscribed browser received events", stopped, changes.get())
            }
        } finally {
            runCatching { socketNetwork(false) }
            runCatching { socketTiming(false) }
            runCatching { delayStreams(false) }
            runCatching { request("/api/library/track-labels/member-track/metadata", "POST", "{\"title\":\"member private song\"}") }
            runCatching { request("/api/library/playlists/Car%20background", "DELETE", null) }
            browser?.let { selected -> instrumentation.runOnMainSync { selected.release() } }
            visible?.close()
            connection.clearSession(true)
        }
    }
}
