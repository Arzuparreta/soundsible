package com.soundsible.android

import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Production transition controller with real decoder HTTP failure and retained successor PCM. */
@UnstableApi
class ProgramDjRecoveryTest {
    @Test fun httpOutgoingBeforeOverlap() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsOutgoingBeforeOverlap() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    @Test fun httpStarvedIncoming() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), 1)
    @Test fun tlsStarvedIncoming() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), 1)
    @Test fun httpStarvedOutgoing() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), 0)
    @Test fun tlsStarvedOutgoing() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), 0)
    private fun run(origin: String?, starved: Int? = null) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val connection = EngineConnection.shared(instrumentation.targetContext)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        val json = "application/json".toMediaType()
        var session: ProgramDjSession? = null
        val tap = ProgramPcmTap()
        val successorKey = AtomicReference<String>()
        val successorPcm = AtomicBoolean()
        val minimumFrame = AtomicLong(if (starved == null) 0 else Long.MAX_VALUE)
        val capture = tap.subscribe({ it.generation == generation }) { block ->
            if (block.frameOffset >= minimumFrame.get() && block.stream.key == successorKey.get() && block.sampleRate == 48000 && block.channels == 2 && block.bytes.any { it != 0.toByte() }) successorPcm.set(true)
        }
        fun await(condition: () -> Boolean) {
            val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (System.nanoTime() < until) {
                val accepted = AtomicBoolean()
                instrumentation.runOnMainSync { accepted.set(condition()) }
                if (accepted.get()) return
                Thread.sleep(50)
            }
            fail("Production DJ recovery condition timed out")
        }
        try {
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody(json), emptyMap(), generation, "recovery-login", 15000).use { assertTrue(it.isSuccessful) }
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                .post("{\"album\":true,\"firstFrequency\":440,\"firstDuration\":20,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody(json)).build()).execute().use { assertEquals(200, it.code) }
            val identity = connection.sessionIdentity(generation)
            val owns = { connection.generation == generation && connection.sessionIdentity(generation) == identity }
            val client = connection.client.newBuilder().addInterceptor { chain ->
                check(owns())
                chain.proceed(chain.request().newBuilder().header("Cookie", connection.cookieHeader(generation)!!).build())
            }.build()
            lateinit var output: ProgramMixOutput
            lateinit var decks: Array<ExoPlayer>
            instrumentation.runOnMainSync {
                val items = ProgramQueue.items(connection, JSONArray("[{\"source\":\"local\",\"id\":\"member-pcm-soft\",\"title\":\"Outgoing\",\"artist\":\"member\",\"duration\":20},{\"source\":\"local\",\"id\":\"member-pcm-loud\",\"title\":\"Incoming\",\"artist\":\"member\",\"duration\":60}]"))
                successorKey.set(items[if (starved == 1) 0 else 1].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                session = ProgramDjSession(instrumentation.targetContext, generation, owns, DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)), tap, { false }, items.map { ProgramDjSession.Row(it) }, mixing = { starved != null })
                output = ProgramDjSession::class.java.getDeclaredField("output").apply { isAccessible = true }.get(session) as ProgramMixOutput
                @Suppress("UNCHECKED_CAST")
                decks = ProgramDjSession::class.java.getDeclaredField("decks").apply { isAccessible = true }.get(session) as Array<ExoPlayer>
                session!!.player.play()
            }
            await { session!!.player.isPlaying && output.readyInput(1) }
            if (starved != null) {
                await { output.transition()?.let { output.positionUs() * 48000 / 1000000 >= it.start + 4800 } == true }
                val epoch = output.epoch()
                val position = output.positionUs()
                successorPcm.set(false)
                // Stop delivery without an ExoPlayer error or output release: this
                // exercises the PCM watchdog, rather than the decoder error path.
                instrumentation.runOnMainSync { output.pause(true); decks[starved].pause() }
                Thread.sleep(2200)
                assertNull("Paused programme retired an input", output.restoredAt())
                instrumentation.runOnMainSync { output.pause(false) }
                await { output.restoredAt() != null && session!!.player.isPlaying && session!!.player.currentMediaItem?.mediaId == if (starved == 1) "member-pcm-soft" else "member-pcm-loud" }
                minimumFrame.set(output.restoredAt()!! + 9600)
                await { successorPcm.get() }
                assertFalse("Retained PCM consumer failed", capture.failed.get())
                assertEquals("Starvation flushed retained programme PCM", epoch, output.epoch())
                assertTrue("Starvation reset programme clock", output.positionUs() >= position)
                instrumentation.runOnMainSync {
                    assertNull(session!!.player.playerError)
                    assertTrue(session!!.player.playWhenReady)
                }
                return
            }
            instrumentation.runOnMainSync {
                assertNull("Failure must precede an armed overlap", output.transition())
                val original = decks[0].currentMediaItem!!
                decks[0].setMediaItem(original.buildUpon().setUri(original.localConfiguration!!.uri.buildUpon().path("/api/static/stream/missing-recovery-source").build()).build())
                decks[0].prepare(); decks[0].play()
            }
            await { session!!.player.isPlaying && session!!.player.currentMediaItem?.mediaId == "member-pcm-loud" }
            await { successorPcm.get() }
            assertFalse("Successor PCM capture failed", capture.failed.get())
            instrumentation.runOnMainSync {
                assertNull(session!!.player.playerError)
                assertEquals(2, session!!.player.mediaItemCount)
                assertTrue(session!!.player.playWhenReady)
            }
        } finally {
            instrumentation.runOnMainSync { session?.close() }
            tap.close()
            try {
                for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "recovery-cleanup-$id", 15000).use { assertTrue(it.isSuccessful || it.code == 404) }
            } finally { connection.clearSession(true) }
        }
    }
}
