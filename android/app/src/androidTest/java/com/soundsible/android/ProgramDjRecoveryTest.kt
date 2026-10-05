package com.soundsible.android

import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
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
    @Test fun httpHistoryPrune() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), history = true)
    @Test fun tlsHistoryPrune() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), history = true)
    @Test fun httpMeasuredRefinement() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), measured = true)
    @Test fun tlsMeasuredRefinement() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), measured = true)
    private fun run(origin: String?, starved: Int? = null, history: Boolean = false, measured: Boolean = false) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val connection = EngineConnection.shared(instrumentation.targetContext)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        val json = "application/json".toMediaType()
        var session: ProgramDjSession? = null
        var refiner: ProgramDjRefiner? = null
        var planner: ProgramDjPlanner? = null
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
                val routeItems = if (history) ProgramQueue.items(connection, JSONArray().apply {
                    repeat(1000) { put(JSONObject().put("source", "local").put("id", "member-pcm-soft").put("title", "History $it").put("duration", 20)) }
                }) else items
                successorKey.set(routeItems[if (history) 996 else if (starved == 1) 0 else 1].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                session = ProgramDjSession(instrumentation.targetContext, generation, owns, DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)), tap, { false }, routeItems.map { ProgramDjSession.Row(it) }, mixing = { starved != null })
                output = ProgramDjSession::class.java.getDeclaredField("output").apply { isAccessible = true }.get(session) as ProgramMixOutput
                @Suppress("UNCHECKED_CAST")
                decks = ProgramDjSession::class.java.getDeclaredField("decks").apply { isAccessible = true }.get(session) as Array<ExoPlayer>
                if (history) {
                    session!!.seek(996, 6000)
                    val snapshot = session!!.routeSnapshot()
                    val proposal = ProgramDjPlan.Proposal(successorKey.get(), ProgramMixCurve.Technique.SAFE_FADE, 14.0, 0.0, 4.0, 1.0, 0.5)
                    assertTrue("Uncommitted refinement rejected", session!!.applyRefinement(snapshot, proposal))
                    assertFalse("Obsolete refinement accepted", session!!.applyRefinement(snapshot, proposal))
                }
                if (!measured) session!!.player.play()
            }
            if (measured) {
                lateinit var body: JSONObject
                instrumentation.runOnMainSync {
                    planner = ProgramDjPlanner(connection, session!!.player, android.os.Handler(android.os.Looper.getMainLooper()), { emptySet() }, { _, _, _ -> }, { _, _, _ -> })
                    body = JSONObject().put("dj_profile", "adaptive").put("from", planner!!.reference(session!!.items()[0])).put("to", planner!!.reference(session!!.items()[1]))
                }
                var answer: JSONObject? = null
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (System.nanoTime() < deadline) {
                    connection.execute("/api/discovery/music/dj-transition", "POST", body.toString().toRequestBody(json), emptyMap(), generation, "measured-probe", 8000).use {
                        assertTrue(it.isSuccessful)
                        answer = JSONObject(it.body!!.string())
                    }
                    if (answer!!.optBoolean("measured")) break
                    Thread.sleep(200)
                }
                assertTrue("Real Core analysis did not become measured", answer!!.optBoolean("measured"))
                var revision = 0L
                instrumentation.runOnMainSync {
                    revision = session!!.routeSnapshot().revision
                    refiner = ProgramDjRefiner(connection, android.os.Handler(android.os.Looper.getMainLooper()), { session }, planner!!)
                    refiner!!.refine(session!!)
                }
                await { session!!.routeSnapshot().revision > revision }
                instrumentation.runOnMainSync {
                    val proposal = session!!.routeSnapshot().rows[1].proposal!!
                    assertEquals(answer!!.getJSONObject("transition").getDouble("out_cue"), proposal.outCue, 0.000001)
                    assertEquals(session!!.items()[0].mediaMetadata.extras!!.getString(ProgramQueue.KEY), proposal.fromKey)
                    assertFalse(session!!.player.playWhenReady)
                    val snapshot = session!!.routeSnapshot()
                    assertTrue(session!!.editFuture(snapshot, snapshot.rows.drop(snapshot.floor + 1).map { it.copy(proposal = null) }))
                    planner!!.start("long_blend", JSONObject(), JSONArray(), true, ProgramDjPlanner.Kind.REPLACE)
                    planner!!.clear()
                    revision = session!!.routeSnapshot().revision
                    refiner!!.refine(session!!)
                }
                await { session!!.routeSnapshot().revision > revision }
                instrumentation.runOnMainSync {
                    assertNotNull("Settings change did not refine the retained pair", session!!.routeSnapshot().rows[1].proposal)
                    session!!.player.play()
                }
                await { session!!.player.isPlaying }
                return
            }
            if (history) {
                await { session!!.player.isPlaying && session!!.items().size == 4 && session!!.currentIndex() == 0 && successorPcm.get() }
                instrumentation.runOnMainSync { session!!.player.pause() }
                Thread.sleep(300)
                instrumentation.runOnMainSync {
                    val owner = session!!
                    val epoch = output.epoch()
                    val position = owner.player.currentPosition
                    val key = owner.player.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY)
                    assertEquals(successorKey.get(), key)
                    assertTrue(owner.heardIds().contains("member-pcm-soft"))
                    val program = owner.items().first().mediaMetadata.extras!!.getString(ProgramQueue.PROGRAM)!!
                    val appended = ProgramQueue.items(connection, JSONArray("[{\"source\":\"local\",\"id\":\"member-pcm-loud\",\"title\":\"Refill\"}]"), program)
                    owner.append(appended.map { ProgramDjSession.Row(it) })
                    assertEquals(5, owner.items().size)
                    assertEquals(key, owner.player.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                    assertEquals(position, owner.player.currentPosition)
                    assertEquals(epoch, output.epoch())
                    assertFalse(owner.player.playWhenReady)
                    minimumFrame.set(output.reservedPositionUs() * 48000 / 1000000 + 4800)
                    successorPcm.set(false)
                    owner.player.play()
                }
                await { successorPcm.get() }
                assertFalse(capture.failed.get())
                return
            }
            await { session!!.player.isPlaying && output.readyInput(1) }
            instrumentation.runOnMainSync {
                val snapshot = session!!.routeSnapshot()
                val key = session!!.player.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY)!!
                assertFalse("Prepared cue changed by late refinement", session!!.applyRefinement(snapshot,
                    ProgramDjPlan.Proposal(key, ProgramMixCurve.Technique.SAFE_FADE, 10.0, 0.0, 4.0, 1.0, 0.5)))
            }
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
            instrumentation.runOnMainSync { refiner?.close(); planner?.close(); session?.close() }
            tap.close()
            try {
                for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "recovery-cleanup-$id", 15000).use { assertTrue(it.isSuccessful || it.code == 404) }
            } finally { connection.clearSession(true) }
        }
    }
}
