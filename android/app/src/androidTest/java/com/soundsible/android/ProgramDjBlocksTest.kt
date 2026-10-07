package com.soundsible.android

import android.os.Bundle
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
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

/** Real decoder/output session: bridge ownership survives moves and protects audible dependencies. */
@UnstableApi
class ProgramDjBlocksTest {
    @Test fun httpOwnedBridge() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsOwnedBridge() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val connection = EngineConnection.shared(instrumentation.targetContext)
        connection.clearSession(true)
        val generation = connection.configure(origin!!)
        val json = "application/json".toMediaType()
        var session: ProgramDjSession? = null
        val tap = ProgramPcmTap()
        val pcm = AtomicBoolean()
        val capture = tap.subscribe({ it.generation == generation }) { block ->
            if (block.bytes.any { it != 0.toByte() }) pcm.set(true)
        }
        try {
            connection.execute("/api/auth/login", "POST", "{\"username\":\"member\",\"password\":\"android-test\"}".toRequestBody(json), emptyMap(), generation, "blocks-login", 15000).use { assertTrue(it.isSuccessful) }
            connection.client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                .post("{\"album\":true,\"firstFrequency\":440,\"firstDuration\":20,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody(json)).build()).execute().use { assertEquals(200, it.code) }
            val identity = connection.sessionIdentity(generation)
            val owns = { generation == connection.generation && connection.sessionIdentity(generation) == identity }
            val client = connection.client.newBuilder().addInterceptor { chain ->
                check(owns()); chain.proceed(chain.request().newBuilder().header("Cookie", connection.cookieHeader(generation)!!).build())
            }.build()
            instrumentation.runOnMainSync {
                val items = ProgramQueue.items(connection, JSONArray().apply { repeat(4) { index ->
                    put(JSONObject().put("source", "local").put("id", "member-pcm-soft").put("title", "Block $index").put("duration", 20))
                } })
                fun key(index: Int) = items[index].mediaMetadata.extras!!.getString(ProgramQueue.KEY)!!
                val extras = Bundle(items[1].mediaMetadata.extras).apply { putString(ProgramQueue.BRIDGE_OWNER, key(2)) }
                val bridge = items[1].buildUpon().setMediaMetadata(items[1].mediaMetadata.buildUpon().setExtras(extras).build()).build()
                val rows = listOf(ProgramDjSession.Row(items[0]), ProgramDjSession.Row(bridge, kind = "bridge"), ProgramDjSession.Row(items[2]), ProgramDjSession.Row(items[3]))
                val owner = ProgramDjSession(instrumentation.targetContext, generation, owns, DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)), tap, { false }, rows, mixing = { false })
                session = owner
                val epoch = owner.routeSnapshot().epoch
                assertEquals(key(1), owner.blockStartKey(key(2)))
                val extra = ProgramQueue.items(connection, JSONArray("[{\"source\":\"local\",\"id\":\"member-pcm-soft\",\"title\":\"Extra\"}]"), items[0].mediaMetadata.extras!!.getString(ProgramQueue.PROGRAM)!!).single()
                owner.addRequested(extra, key(2))
                assertEquals(key(1), owner.items()[2].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                owner.editBlock("remove", 1, 1)
                owner.editBlock("move", 2, 3)
                assertEquals(listOf(key(0), key(3), key(1), key(2)), owner.items().map { it.mediaMetadata.extras!!.getString(ProgramQueue.KEY) })
                assertEquals(key(0), owner.player.currentMediaItem!!.mediaMetadata.extras!!.getString(ProgramQueue.KEY)); assertFalse(owner.player.playWhenReady)
                owner.editBlock("move", 2, 1)
                assertEquals(listOf(key(0), key(1), key(2), key(3)), owner.items().map { it.mediaMetadata.extras!!.getString(ProgramQueue.KEY) })
                assertEquals(epoch, owner.routeSnapshot().epoch)
                owner.seek(1, 2000)
                assertTrue(owner.protectedKeys().contains(key(2)))
                assertEquals(3, owner.editableFrom())
                assertThrows(IllegalArgumentException::class.java) { owner.addRequested(extra, key(2)) }
                val lockedSnapshot = owner.routeSnapshot()
                assertThrows(IllegalArgumentException::class.java) { owner.editFuture(lockedSnapshot, lockedSnapshot.rows.drop(2).reversed()) }
                owner.addRequested(extra, null)
                assertEquals(key(2), owner.items()[2].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                assertEquals(extra.mediaMetadata.extras!!.getString(ProgramQueue.KEY), owner.items()[3].mediaMetadata.extras!!.getString(ProgramQueue.KEY))
                owner.editBlock("remove", 3, 3)
                assertThrows(IllegalArgumentException::class.java) { owner.editBlock("remove", 2, 2) }
                assertThrows(IllegalArgumentException::class.java) { owner.editBlock("move", 2, 3) }
                assertEquals(2000, owner.player.currentPosition)
                owner.seek(0, 0)
                val retainedEpoch = owner.routeSnapshot().epoch
                owner.editBlock("remove", 1, 1)
                assertEquals(retainedEpoch, owner.routeSnapshot().epoch)
                assertEquals(listOf(key(0), key(3)), owner.items().map { it.mediaMetadata.extras!!.getString(ProgramQueue.KEY) })
                assertEquals(0, owner.player.currentPosition); assertFalse(owner.player.playWhenReady)
                owner.player.play()
            }
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (!pcm.get() && System.nanoTime() < deadline) Thread.sleep(50)
            if (!pcm.get()) {
                // The failing state is the evidence: audio focus, decoder error or an idle output.
                val state = StringBuilder()
                instrumentation.runOnMainSync {
                    val owner = session!!
                    val player = owner.player
                    state.append("playWhenReady=${player.playWhenReady} state=${player.playbackState} suppression=${player.playbackSuppressionReason} error=${player.playerError} position=${player.currentPosition} items=${owner.items().size}")
                    @Suppress("UNCHECKED_CAST")
                    val decks = ProgramDjSession::class.java.getDeclaredField("decks").apply { isAccessible = true }.get(owner) as Array<androidx.media3.exoplayer.ExoPlayer>
                    decks.forEachIndexed { slot, deck -> state.append(" deck$slot[item=${deck.currentMediaItem?.mediaId} state=${deck.playbackState} playWhenReady=${deck.playWhenReady} error=${deck.playerError}]") }
                }
                fail("Retained decoder did not produce PCM after route block edits: $state")
            }
            assertFalse(capture.failed.get())
        } finally {
            instrumentation.runOnMainSync { session?.close() }; capture.close(); tap.close()
            for (id in listOf("member-pcm-soft", "member-pcm-loud")) connection.execute("/api/library/tracks/$id", "DELETE", null, emptyMap(), generation, "blocks-cleanup-$id", 15000).close()
            connection.clearSession(true)
        }
    }
}
