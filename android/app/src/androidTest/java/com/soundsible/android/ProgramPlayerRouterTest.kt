package com.soundsible.android

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

@UnstableApi
class ProgramPlayerRouterTest {
    @Test fun controlsAndEventsFollowOnlyTheCurrentBackend() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var first: ExoPlayer
        lateinit var second: ExoPlayer
        lateinit var router: ProgramPlayerRouter
        val backends = mutableListOf<ExoPlayer>()
        var releaseRouter: (() -> Unit)? = null
        var events = 0
        fun main(block: () -> Unit) { instrumentation.runOnMainSync(block); instrumentation.waitForIdleSync() }
        try {
            main {
                first = ExoPlayer.Builder(instrumentation.targetContext).build().also { backends.add(it) }
                second = ExoPlayer.Builder(instrumentation.targetContext).build().also { backends.add(it) }
                router = ProgramPlayerRouter(first)
                releaseRouter = { router.release() }
                router.addListener(object : Player.Listener {
                    override fun onEvents(player: Player, changes: Player.Events) { events++ }
                })
                router.setMediaItem(MediaItem.Builder().setMediaId("normal-occurrence").setUri("asset:///router-test.wav").build())
                router.volume = 0.4f
            }
            main {
                assertEquals("normal-occurrence", router.currentMediaItem!!.mediaId)
                assertEquals(0.4, first.volume.toDouble(), 0.001)
                assertTrue(events > 0)
                second.setMediaItem(MediaItem.Builder().setMediaId("dj-occurrence").setUri("asset:///router-test.wav").build())
                second.volume = 0.7f
                assertSame(first, router.replaceBackend(second))
            }
            main {
                assertEquals("dj-occurrence", router.currentMediaItem!!.mediaId)
                assertEquals(0.7, router.volume.toDouble(), 0.001)
            }
            val switchedEvents = events
            main {
                first.setMediaItem(MediaItem.Builder().setMediaId("retired-occurrence").setUri("asset:///router-test.wav").build())
                first.volume = 0.2f
            }
            main {
                assertEquals("Retired backend leaked events", switchedEvents, events)
                assertEquals("dj-occurrence", router.currentMediaItem!!.mediaId)
                router.volume = 0.5f
                router.play()
                assertTrue(second.playWhenReady)
                assertFalse(first.playWhenReady)
                router.pause()
                router.clearMediaItems()
                assertEquals(0, second.mediaItemCount)
                assertEquals(1, first.mediaItemCount)
            }
        } finally {
            main { releaseRouter?.invoke(); backends.forEach { it.release() } }
        }
    }

    @Test fun refusesASecondOutputWhileThePreviousProgrammeIsRequested() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val first = ExoPlayer.Builder(instrumentation.targetContext).build()
            val second = ExoPlayer.Builder(instrumentation.targetContext).build()
            val router = ProgramPlayerRouter(first)
            try {
                first.play()
                try { router.replaceBackend(second); fail("Allowed an active previous programme") }
                catch (_: IllegalStateException) { }
                assertTrue(router.playWhenReady)
                first.pause(); first.stop()
                second.play()
                try { router.replaceBackend(second); fail("Allowed an already started next programme") }
                catch (_: IllegalStateException) { }
                second.pause(); second.stop()
                assertSame(first, router.replaceBackend(second))
            } finally { router.release(); first.release(); second.release() }
        }
    }
}
