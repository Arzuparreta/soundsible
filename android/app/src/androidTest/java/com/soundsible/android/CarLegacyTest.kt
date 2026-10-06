package com.soundsible.android

import android.content.ComponentName
import android.content.pm.PackageManager
import android.media.browse.MediaBrowser as LegacyBrowser
import android.media.session.MediaController as LegacyController
import android.media.session.PlaybackState
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.common.util.UnstableApi
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Platform media-browser protocol used by car clients; still not an Android Auto host. */
@UnstableApi
class CarLegacyTest {
    @Test fun httpLegacyBrowseAndPlay() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsLegacyBrowseAndPlay() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        var browser: LegacyBrowser? = null
        try {
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody("application/json".toMediaType()), emptyMap(), generation, "car-legacy-login", 15000).use {
                assertTrue(it.isSuccessful); connection.offline.bind(JSONObject(it.body!!.string()).getJSONObject("user"))
            }
            ActivityScenario.launch(MainActivity::class.java).use {
                @Suppress("DEPRECATION")
                val metadata = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
                assertTrue(metadata.getInt("com.google.android.gms.car.application") != 0)
                val connected = CompletableFuture<Boolean>()
                instrumentation.runOnMainSync {
                    browser = LegacyBrowser(context, ComponentName(context, PlaybackService::class.java), object : LegacyBrowser.ConnectionCallback() {
                        override fun onConnected() { connected.complete(true) }
                        override fun onConnectionFailed() { connected.complete(false) }
                    }, null)
                    browser!!.connect()
                }
                assertTrue(connected.get(20, TimeUnit.SECONDS))
                val rows = CompletableFuture<List<LegacyBrowser.MediaItem>>()
                instrumentation.runOnMainSync {
                    assertEquals(ProgramCarLibrary.ROOT, browser!!.root)
                    browser!!.subscribe("all-tracks", object : LegacyBrowser.SubscriptionCallback() {
                        override fun onChildrenLoaded(parentId: String, children: MutableList<LegacyBrowser.MediaItem>) { rows.complete(children) }
                        override fun onError(parentId: String) { rows.completeExceptionally(IllegalStateException("Legacy browse failed")) }
                    })
                }
                val song = rows.get(20, TimeUnit.SECONDS).single { row -> row.mediaId == "soundsible:track:member-track" }
                assertTrue(song.isPlayable); assertEquals("member private song", song.description.title.toString())
                val pcm = AtomicBoolean()
                NativeProgramOutput.subscribe(generation) { block -> if (block.bytes.any { byte -> byte != 0.toByte() }) pcm.set(true) }.use { capture ->
                    lateinit var controller: LegacyController
                    instrumentation.runOnMainSync {
                        controller = LegacyController(context, browser!!.sessionToken)
                        controller.transportControls.playFromMediaId(song.mediaId, null)
                    }
                    val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                    while (System.nanoTime() < until) {
                        if (controller.playbackState?.state == PlaybackState.STATE_PLAYING && pcm.get()) break
                        Thread.sleep(100)
                    }
                    assertEquals(PlaybackState.STATE_PLAYING, controller.playbackState?.state)
                    assertTrue(pcm.get()); assertFalse(capture.failed.get())
                    instrumentation.runOnMainSync { controller.transportControls.pause() }
                    val paused = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (controller.playbackState?.state != PlaybackState.STATE_PAUSED && System.nanoTime() < paused) Thread.sleep(50)
                    assertEquals(PlaybackState.STATE_PAUSED, controller.playbackState?.state)
                    pcm.set(false)
                    instrumentation.runOnMainSync { controller.transportControls.playFromSearch("member private song", null) }
                    val searched = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
                    while (System.nanoTime() < searched) {
                        if (controller.playbackState?.state == PlaybackState.STATE_PLAYING && pcm.get()) break
                        Thread.sleep(100)
                    }
                    assertEquals(PlaybackState.STATE_PLAYING, controller.playbackState?.state)
                    assertTrue(pcm.get()); assertFalse(capture.failed.get())
                    assertEquals("member private song", controller.metadata?.getString(android.media.MediaMetadata.METADATA_KEY_TITLE))
                    instrumentation.runOnMainSync { controller.transportControls.pause() }
                }
            }
        } finally {
            instrumentation.runOnMainSync { browser?.disconnect() }
            connection.clearSession(true)
        }
    }
}
