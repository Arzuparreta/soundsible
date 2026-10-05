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
import java.util.concurrent.atomic.AtomicReference

/** Production transition controller with real decoder HTTP failure and retained successor PCM. */
@UnstableApi
class ProgramDjRecoveryTest {
    @Test fun httpOutgoingBeforeOverlap() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsOutgoingBeforeOverlap() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
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
        val capture = tap.subscribe({ it.generation == generation }) { block ->
            if (block.stream.key == successorKey.get() && block.sampleRate == 48000 && block.channels == 2 && block.bytes.any { it != 0.toByte() }) successorPcm.set(true)
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
                successorKey.set(items[1].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                session = ProgramDjSession(instrumentation.targetContext, generation, owns, DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)), tap, { false }, items.map { ProgramDjSession.Row(it) }, mixing = { false })
                output = ProgramDjSession::class.java.getDeclaredField("output").apply { isAccessible = true }.get(session) as ProgramMixOutput
                @Suppress("UNCHECKED_CAST")
                decks = ProgramDjSession::class.java.getDeclaredField("decks").apply { isAccessible = true }.get(session) as Array<ExoPlayer>
                session!!.player.play()
            }
            await { session!!.player.isPlaying && output.readyInput(1) }
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
