package com.soundsible.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/** Retained unresolved occurrences resolve through actual Core on native open, without Activity. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class DeviceCatalogSessionTest {
    @Test fun httpCatalogDevice() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin")!!)
    @Test fun tlsCatalogDevice() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin")!!)
    private fun run(origin: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation(); val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context); connection.clearSession(true); val epoch = connection.configure(origin)
        fun core(path: String, method: String = "GET", body: JSONObject? = null): JSONObject = connection.execute(path, method,
            body?.toString()?.toRequestBody("application/json".toMediaType()), emptyMap(), epoch, "device-catalog-${java.util.UUID.randomUUID()}", 15000).use {
                val text = it.body?.string().orEmpty(); assertEquals("$path: $text", 200, it.code); if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        core("/api/auth/login", "POST", JSONObject().put("username", "member").put("password", "android-test"))
        core("/api/discovery/settings", "PATCH", JSONObject().put("autoplay_enabled", false))
        fun <T> main(work: () -> T): T { val value = AtomicReference<T>(); instrumentation.runOnMainSync { value.set(work()) }; return value.get() }
        fun await(label: String, condition: () -> Boolean) { val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < until) { if (condition()) return; Thread.sleep(50) }; fail(label) }
        val peerId = java.util.UUID.randomUUID().toString()
        core("/api/devices/register", "POST", JSONObject().put("device_id", peerId).put("device_name", "Catalog peer").put("device_type", "desktop"))
        var scenario: ActivityScenario<MainActivity>? = null; var browser: MediaBrowser? = null; var capture: ProgramPcmTap.Capture? = null
        val pcm = AtomicBoolean()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val active = main { MediaBrowser.Builder(context, SessionToken(context, android.content.ComponentName(context, PlaybackService::class.java))).buildAsync() }.get(15, TimeUnit.SECONDS)
            browser = active
            await("Native device not connected") { main { active.sessionExtras.getString("nativeDevice") }?.let { JSONObject(it).optBoolean("connected") } == true }
            val id = JSONObject(main { active.sessionExtras.getString("nativeDevice") }!!).getString("device_id")
            scenario.close(); scenario = null
            fun pending(id: String, title: String) = JSONObject().put("id", id).put("title", title).put("artist", "fixture artist")
                .put("queueId", id).put("queueLane", "context").put("queueSource", "album")
                .put("queueContext", JSONObject().put("id", "catalog-album").put("kind", "album").put("label", "Catalog album"))
                .put("pendingResolve", JSONObject().put("catalogItemId", id).put("artist", "fixture artist").put("title", title).put("duration", 60))
            val queue = JSONArray().put(JSONObject().put("id", "member-track").put("title", "Current local").put("queueId", "local").put("queueLane", "manual").put("queueSource", "library"))
                .put(pending("deezer:track:900001", "fixture resolved song"))
                .put(pending("deezer:track:900002", "unresolved fixture future"))
            fun handoff(rows: JSONArray, index: Int) {
                val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", rows).put("index", index).put("shuffle", false).put("repeat", "off")
                    .put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", JSONObject.NULL)
                core("/api/playback/state", "PUT", JSONObject().put("device_id", peerId).put("track_id", rows.getJSONObject(index).getString("id"))
                    .put("track", rows.getJSONObject(index)).put("position_sec", 0).put("is_playing", false).put("session", session))
                core("/api/playback/handoff", "POST", JSONObject().put("from_device_id", peerId).put("to_device_id", id))
            }
            capture = NativeProgramOutput.subscribe(epoch) { block -> if (block.bytes.any { it != 0.toByte() }) pcm.set(true) }
            handoff(queue, 0)
            await("Pending handoff dropped queue or local PCM") { main { active.mediaItemCount == 3 && active.currentMediaItemIndex == 0 && active.isPlaying } && pcm.get() }
            val key = main { ProgramQueue.key(active, 1) }
            assertNotNull(main { active.getMediaItemAt(2).mediaMetadata.extras?.getString(ProgramQueue.PENDING) })
            pcm.set(false); main { active.seekToNextMediaItem() }
            await("Native deferred catalog did not resolve selected occurrence and PCM") { main { active.currentMediaItemIndex == 1 && active.currentMediaItem?.mediaId == "C1111111111" && active.isPlaying } && pcm.get() }
            assertEquals("Resolution replaced occurrence identity", key, main { ProgramQueue.key(active, 1) })
            assertEquals(3, main { active.mediaItemCount })
            assertNotNull(main { active.getMediaItemAt(2).mediaMetadata.extras?.getString(ProgramQueue.PENDING) })
            await("Resolved and pending state were not republished") {
                val state = core("/api/playback/state").optJSONObject("session") ?: return@await false
                state.getJSONArray("queue").getJSONObject(1).optString("source") == "preview" && state.getJSONArray("queue").getJSONObject(2).has("pendingResolve")
            }
            val wire = core("/api/playback/state").getJSONObject("session").getJSONArray("queue")
            assertEquals("catalog-album", wire.getJSONObject(1).getJSONObject("queueContext").getString("id"))
            // Replay the resolved alias: no second matcher call or native placeholder HTTP path.
            main { active.seekTo(0); active.prepare(); active.play() }; pcm.set(false)
            await("Resolved occurrence retry lost PCM") { pcm.get() && main { active.isPlaying && active.currentMediaItem?.mediaId == "C1111111111" } }
            val stats = core("/api/android-fixture/catalog-stats").getJSONArray("calls")
            assertEquals(1, (0 until stats.length()).count { stats.getJSONObject(it).optString("provider") == "resolution" && stats.getJSONObject(it).optString("title") == "fixture resolved song" })
            // A matcher404 removes only its occurrence and continues to the next playable song.
            val continuation = JSONArray().put(pending("deezer:track:missing", "unmatched fixture song"))
                .put(JSONObject().put("id", "member-track").put("title", "After unmatched").put("queueId", "after").put("queueLane", "manual").put("queueSource", "library"))
            pcm.set(false); handoff(continuation, 0)
            await("Unmatched catalogue entry stopped the collection") { main { active.mediaItemCount == 1 && active.currentMediaItem?.mediaId == "member-track" && active.isPlaying } && pcm.get() }
            fun control(status: Int, failures: Int) {
                val body = JSONObject().put("resolve_status", status).put("resolve_failures", failures).toString().toRequestBody("application/json".toMediaType())
                connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/catalog").header("X-Android-Fixture", "isolated").post(body).build()).execute().use { assertEquals(200, it.code) }
            }
            // Two temporary matcher errors retry natively without dropping the row or reopening Activity.
            val initialFailures = core("/api/android-fixture/catalog-stats").getJSONArray("requests").let { rows -> (0 until rows.length()).count { rows.getJSONObject(it).optString("path") == "/api/catalog/resolve" && rows.getJSONObject(it).optInt("status") == 503 } }
            control(503, 2)
            pcm.set(false); handoff(JSONArray().put(pending("deezer:track:retry", "fixture resolved song")), 0)
            await("Temporary matcher errors did not recover native PCM") { main { active.mediaItemCount == 1 && active.currentMediaItem?.mediaId == "C1111111111" && active.isPlaying } && pcm.get() }
            control(503, -1)
            handoff(JSONArray().put(pending("deezer:track:exhaust", "fixture resolved song")), 0)
            await("Matcher retry did not exhaust") { main { active.playerError != null } }
            assertEquals(1, main { active.mediaItemCount })
            assertNotNull(main { active.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.PENDING) })
            val failuresBefore = core("/api/android-fixture/catalog-stats").getJSONArray("requests").let { rows -> (0 until rows.length()).count { rows.getJSONObject(it).optString("path") == "/api/catalog/resolve" && rows.getJSONObject(it).optInt("status") == 503 } }
            assertEquals(initialFailures + 5, failuresBefore)
            Thread.sleep(2500)
            val failuresAfter = core("/api/android-fixture/catalog-stats").getJSONArray("requests").let { rows -> (0 until rows.length()).count { rows.getJSONObject(it).optString("path") == "/api/catalog/resolve" && rows.getJSONObject(it).optInt("status") == 503 } }
            assertEquals(failuresBefore, failuresAfter)
            control(0, 0); pcm.set(false); main { active.prepare(); active.play() }
            await("Explicit retry did not recover exhausted matcher") { pcm.get() && main { active.isPlaying && active.currentMediaItem?.mediaId == "C1111111111" } }
            // Reset while a real delayed matcher is in flight cannot populate the cleared programme.
            val delayed = JSONArray().put(pending("deezer:track:999999", "fixture review song cancel"))
            handoff(delayed, 0)
            await("Delayed matcher never started") { val calls = core("/api/android-fixture/catalog-stats").getJSONArray("calls")
                (0 until calls.length()).any { calls.getJSONObject(it).optString("title") == "fixture review song cancel" } }
            main { connection.clearSession(false) }
            Thread.sleep(6000)
            assertEquals(0, main { active.mediaItemCount }); assertFalse(NativeProgramOutput.playing)
        } finally {
            runCatching { connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/catalog").header("X-Android-Fixture", "isolated").post("{\"resolve_status\":0,\"resolve_failures\":0}".toRequestBody("application/json".toMediaType())).build()).execute().close() }
            capture?.close(); main { browser?.release() }; scenario?.close(); connection.clearSession(true) }
    }
}
