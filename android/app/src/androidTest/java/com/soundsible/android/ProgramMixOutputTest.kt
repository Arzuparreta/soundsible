package com.soundsible.android

import android.os.Handler
import android.os.Looper
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.*

/** Isolated two-decoder spike. Idle production service never owns a second audible output. */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class ProgramMixOutputTest {
    private val web = StartupTest()
    private fun waitFor(scenario: ActivityScenario<MainActivity>, condition: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(40)
        while (System.nanoTime() < deadline) {
            if (web.evaluate(scenario, condition) == "true") return
            Thread.sleep(100)
        }
        fail("Mix spike condition not reached")
    }
    private data class Spectrum(val start: Long, val first: Double, val second: Double, val marker: Double)
    private class Meter(private val frequencies: IntArray = intArrayOf(440, 880, 1320)) {
        val metrics = ArrayBlockingQueue<Spectrum>(32)
        var start = 0L; var count = 0
        val real = DoubleArray(3); val imaginary = DoubleArray(3)
        fun accept(bytes: ByteArray, rate: Int, channels: Int, frame: Long) {
            val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            var offset = 0
            while (input.hasRemaining()) {
                val value = input.short.toDouble(); repeat(channels - 1) { input.short }
                if (count > 0 && frame + offset != start + count) {
                    count = 0; real.fill(0.0); imaginary.fill(0.0)
                }
                if (count == 0) start = frame + offset
                for (index in 0..2) {
                    val phase = 2 * Math.PI * frequencies[index] * (frame + offset) / rate
                    real[index] += value * cos(phase); imaginary[index] -= value * sin(phase)
                }
                count++; offset++
                if (count == rate / 10) {
                    metrics.offer(Spectrum(start, hypot(real[0], imaginary[0]) * 2 / count, hypot(real[1], imaginary[1]) * 2 / count, hypot(real[2], imaginary[2]) * 2 / count))
                    count = 0; real.fill(0.0); imaginary.fill(0.0)
                }
            }
        }
        fun await(predicate: (Spectrum) -> Boolean): Spectrum {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (System.nanoTime() < deadline) {
                val sample = metrics.poll(200, TimeUnit.MILLISECONDS) ?: continue
                if (predicate(sample)) return sample
            }
            throw AssertionError("Mixed PCM spectrum not observed")
        }
    }
    @Test fun httpTwoPrivateDecoders() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"))
    @Test fun tlsTwoPrivateDecoders() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"))
    @Test fun httpDirectCut() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.DIRECT)
    @Test fun tlsDirectCut() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.DIRECT)
    @Test fun httpIncomingFailure() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), recoverIncoming = true)
    @Test fun tlsIncomingFailure() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), recoverIncoming = true)
    @Test fun httpLateIncomingFailure() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), recoverIncoming = true, lateFailure = true)
    @Test fun tlsLateIncomingFailure() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), recoverIncoming = true, lateFailure = true)
    @Test fun httpBassSwap() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.BASS_SWAP, effects = true)
    @Test fun tlsBassSwap() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.BASS_SWAP, effects = true)
    @Test fun httpFilterBlend() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.FILTER_BLEND, effects = true)
    @Test fun tlsFilterBlend() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.FILTER_BLEND, effects = true)
    @Test fun httpLongBlend() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.LONG_BLEND, effects = true)
    @Test fun tlsLongBlend() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.LONG_BLEND, effects = true)
    @Test fun httpEchoCut() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.ECHO_CUT, effects = true)
    @Test fun tlsEchoCut() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.ECHO_CUT, effects = true)
    @Test fun httpStructuralFade() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.STRUCTURAL_FADE, effects = true)
    @Test fun tlsStructuralFade() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.STRUCTURAL_FADE, effects = true)
    @Test fun httpFlacMix() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), secondFormat = "flac")
    @Test fun tlsFlacMix() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), secondFormat = "flac")
    @Test fun httpEndOfSource() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), ProgramMixCurve.Technique.DIRECT, endOfSource = true)
    @Test fun tlsEndOfSource() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), ProgramMixCurve.Technique.DIRECT, endOfSource = true)
    @Test fun httpTempoMix() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), tempo = 1.05f)
    @Test fun tlsTempoMix() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), tempo = 1.05f)
    @Test fun httpCuedPreroll() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), cued = true)
    @Test fun tlsCuedPreroll() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), cued = true)
    @Test fun httpCancelPreroll() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), cued = true, cancelCue = true)
    @Test fun tlsCancelPreroll() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), cued = true, cancelCue = true)
    @Test fun httpTempoReturn() = run(InstrumentationRegistry.getArguments().getString("fixtureOrigin"), tempo = 1.05f, returnTempo = true)
    @Test fun tlsTempoReturn() = run(InstrumentationRegistry.getArguments().getString("tlsOrigin"), tempo = 1.05f, returnTempo = true)
    private fun run(origin: String?, technique: ProgramMixCurve.Technique = ProgramMixCurve.Technique.SAFE_FADE, recoverIncoming: Boolean = false, lateFailure: Boolean = false, effects: Boolean = false, secondFormat: String = "wav", endOfSource: Boolean = false, tempo: Float = 1f, cued: Boolean = false, cancelCue: Boolean = false, returnTempo: Boolean = false) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val decoders = mutableListOf<ExoPlayer>()
        var mix: ProgramMixOutput? = null
        var rateReturn: ProgramRateReturn? = null
        var audioClient: okhttp3.OkHttpClient? = null
        val playbackFailure = AtomicReference<PlaybackException?>()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                web.awaitReady(scenario); web.evaluate(scenario, "localStorage.setItem('lang','en')"); scenario.recreate(); web.awaitReady(scenario)
                web.evaluate(scenario, "document.querySelector('input[type=url]').value=${JSONObject.quote(origin)};document.querySelector('input[type=url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit()")
                waitFor(scenario, "!!document.querySelector('input[type=password]')")
                web.evaluate(scenario, "document.querySelector('input[autocomplete=username]').value='member';document.querySelector('input[type=password]').value='android-test';document.querySelector('input[type=password]').form.requestSubmit()")
                waitFor(scenario, "!!document.querySelector('[data-testid=android-library]')")
                val generation = connection.generation
                val identity = connection.sessionIdentity(generation)
                val owns = { connection.generation == generation && runCatching { connection.sessionIdentity(generation) }.getOrNull() == identity }
                val client = connection.client.newBuilder().dispatcher(okhttp3.Dispatcher()).connectionPool(okhttp3.ConnectionPool()).addInterceptor { chain ->
                    check(owns()); val cookie = connection.cookieHeader(generation) ?: error("Session absent")
                    val response = chain.proceed(chain.request().newBuilder().header("Cookie", cookie).build())
                    if (!owns()) { response.close(); error("Session changed") }
                    response
                }.build()
                val firstFrequency = if (effects) if (technique == ProgramMixCurve.Technique.ECHO_CUT) 100 else 80 else 440
                val secondFrequency = if (effects) 4400 else if (tempo != 1f) 1600 else 880
                val tones = JSONObject().put("album", true).put("firstMarker", !effects)
                    .put("secondFrequency", secondFrequency).put("secondRate", 48000).put("secondChannels", 2).put("secondFormat", secondFormat)
                if (effects) tones.put("firstFrequency", firstFrequency)
                client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                    .post(tones.toString().toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                audioClient = client
                val meter = Meter(intArrayOf(firstFrequency, secondFrequency, 1320))
                val owner = ProgramMixOutput(context, owns, meter::accept); mix = owner
                instrumentation.runOnMainSync {
                    for ((index, id) in listOf("member-pcm-soft", "member-pcm-loud").withIndex()) {
                        val renderer = object : DefaultRenderersFactory(context) {
                            override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParams: Boolean): AudioSink {
                                val channels = ChannelMixingAudioProcessor().apply {
                                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(1, 2))
                                    putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(2, 2))
                                }
                                val resampler = SonicAudioProcessor().apply { setOutputSampleRateHz(48000) }
                                return DefaultAudioSink.Builder(context).setEnableFloatOutput(false)
                                    .setEnableAudioOutputPlaybackParameters(false)
                                    .setAudioProcessors(arrayOf(channels, resampler))
                                    .setAudioOutputProvider(owner.input(index)).build()
                            }
                        }
                        val decoder = ExoPlayer.Builder(context, renderer).setPlaybackLooper(owner.playbackLooper).setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(client))).build()
                        decoder.addListener(object : Player.Listener { override fun onPlayerError(problem: PlaybackException) { playbackFailure.set(problem) } })
                        decoder.setMediaItem(androidx.media3.common.MediaItem.fromUri(origin + "/api/static/stream/" + id))
                        if (index == 1) decoder.playbackParameters = PlaybackParameters(tempo, 1f)
                        decoder.prepare(); decoder.play(); decoders.add(decoder)
                    }
                }
                meter.await { it.first in 2950.0..3050.0 && it.second < 30 }
                if (!effects) {
                    val beforeSeek = owner.epoch()
                    instrumentation.runOnMainSync { decoders.first().seekTo(if (endOfSource) 19500 else 10000) }
                    val seekDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (owner.epoch() == beforeSeek && System.nanoTime() < seekDeadline) Thread.sleep(20)
                    assertTrue("Master output was not invalidated by seek", owner.epoch() > beforeSeek)
                    meter.metrics.clear()
                    meter.await { it.first < 30 && it.second < 30 && it.marker in 2900.0..3050.0 }
                    assertTrue("Physical output retained the old seek clock", owner.positionUs() < 5000000L)
                }
                if (endOfSource) {
                    val drainDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                    while (!owner.drainedInput(0) && System.nanoTime() < drainDeadline) Thread.sleep(10)
                    assertTrue("Current input did not drain its actual hardware PCM: ${owner.drainState(0)}", owner.drainedInput(0))
                    val ended = java.util.concurrent.atomic.AtomicBoolean()
                    val endedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    do {
                        instrumentation.runOnMainSync { ended.set(decoders[0].playbackState == Player.STATE_ENDED) }
                        if (!ended.get()) Thread.sleep(20)
                    } while (!ended.get() && System.nanoTime() < endedDeadline)
                    assertTrue("Decoder did not confirm actual source end", ended.get())
                }
                owner.setVolume(0.1f)
                val readyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (!owner.readyInput(1) && System.nanoTime() < readyDeadline) Thread.sleep(10)
                assertTrue("Incoming decoder did not prepare actual PCM", owner.readyInput(1))
                if (cued) owner.arm(2000, technique, if (cancelCue) 3000 else 1500, if (cancelCue) 2000 else 500)
                else owner.blend(if (technique == ProgramMixCurve.Technique.DIRECT) 50 else 2000, technique)
                var transition = owner.transition() ?: error("Transition window absent")
                if (cued) {
                    val cueStart = transition.start - if (cancelCue) 96000 else 24000
                    meter.await { it.start in (cueStart + 2400)..(transition.start - 4800) && it.first < 30 && it.second < 30 && it.marker in 2900.0..3050.0 }
                    val clockDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (owner.positionUs() * 48000 / 1000000 < cueStart + 12000 && System.nanoTime() < clockDeadline) Thread.sleep(5)
                    val played = owner.positionUs() * 48000 / 1000000
                    assertTrue("Preroll cue was missed", played in (cueStart + 12000)..(cueStart + 19200))
                    assertEquals("Silent preroll changed metadata", 0, owner.dominantInput())
                    val expected = (played - cueStart) * 1000000 / 48000
                    assertTrue("Silent incoming drifted from programme clock", abs(owner.inputPositionUs(1) - expected) < 20000)
                }
                if (cancelCue) {
                    val epoch = owner.epoch()
                    assertTrue("Uncommitted preroll could not be cancelled", owner.cancelArmed())
                    assertNull("Cancelled cue retained its dominance window", owner.transition())
                    val until = owner.positionUs() + 700000
                    val continueDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (owner.positionUs() < until && System.nanoTime() < continueDeadline) Thread.sleep(10)
                    assertTrue("Cancelling future cue stalled current audio", owner.positionUs() >= until)
                    assertEquals("Cancelled cue promoted incoming metadata", 0, owner.dominantInput())
                    meter.metrics.clear()
                    meter.await { it.first < 30 && it.second < 30 && it.marker in 2900.0..3050.0 }
                    instrumentation.runOnMainSync { decoders[1].seekTo(1000) }
                    val readyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while ((!owner.readyInput(1) || owner.inputPositionUs(1) >= 20000) && System.nanoTime() < readyDeadline) Thread.sleep(10)
                    assertTrue("Corrected standby cue did not rebuffer", owner.readyInput(1))
                    assertEquals("Standby phase correction reset master audio", epoch, owner.epoch())
                    assertTrue("Standby source advanced while silent and unarmed", owner.inputPositionUs(1) < 20000)
                    owner.arm(2000, technique, 300, 200)
                    transition = owner.transition() ?: error("Rearmed transition absent")
                }
                val checkpoints = when {
                    technique == ProgramMixCurve.Technique.DIRECT -> listOf(1.0 to 1)
                    lateFailure -> listOf(0.95 to 1)
                    recoverIncoming -> listOf(0.25 to 0)
                    else -> listOf(0.25 to 0, 0.75 to 1)
                }
                for ((fraction, dominant) in checkpoints) {
                    val target = transition.start + (transition.length * fraction).toLong()
                    val clockDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (owner.positionUs() * 48000 / 1000000 < target && System.nanoTime() < clockDeadline) Thread.sleep(10)
                    assertTrue("Physical transition did not advance", owner.positionUs() * 48000 / 1000000 >= target)
                    assertEquals("Metadata dominance did not follow playout", dominant, owner.dominantInput())
                }
                if (cancelCue) assertFalse("Already committed blend accepted future cancellation", owner.cancelArmed())
                if (effects) {
                    when (technique) {
                        ProgramMixCurve.Technique.BASS_SWAP -> meter.await { it.first in 700.0..1150.0 && it.second in 5500.0..7000.0 }
                        ProgramMixCurve.Technique.FILTER_BLEND, ProgramMixCurve.Technique.LONG_BLEND -> {
                            meter.await { it.start in (transition.start + 2400)..(transition.start + 9600) && it.first in 2800.0..3010.0 && it.second in 10.0..250.0 }
                            if (technique == ProgramMixCurve.Technique.LONG_BLEND) meter.await { it.first in 700.0..1150.0 && it.second in 6000.0..8500.0 }
                            else meter.await { it.first in 1800.0..2400.0 && it.second in 6000.0..8500.0 }
                        }
                        ProgramMixCurve.Technique.ECHO_CUT -> meter.await { it.start >= transition.start + 86400 && it.first > 700 && it.second > 8750 }
                        else -> meter.await { it.first in 1800.0..2400.0 && it.second in 5500.0..7000.0 }
                    }
                } else if (technique != ProgramMixCurve.Technique.DIRECT) {
                    meter.await { it.first < 30 && it.marker in 1800.0..2400.0 && it.second in 5500.0..7000.0 }
                }
                val stable: (Spectrum) -> Boolean = if (recoverIncoming) {
                    val retainedPosition = owner.inputPositionUs(0)
                    instrumentation.runOnMainSync { decoders[1].release(); decoders.removeAt(1) }
                    val restored = owner.restoredAt() ?: error("Outgoing restoration was not scheduled")
                    val clockDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (owner.positionUs() * 48000 / 1000000 < restored + 9600 && System.nanoTime() < clockDeadline) {
                        assertTrue("Retained source clock moved backwards before recovery playout", owner.inputPositionUs(0) + 20000 >= retainedPosition)
                        Thread.sleep(10)
                    }
                    assertTrue("Physical recovery output stalled", owner.positionUs() * 48000 / 1000000 >= restored + 9600)
                    assertEquals("Failed incoming kept metadata ownership", 0, owner.dominantInput())
                    val retained: (Spectrum) -> Boolean = { sample -> sample.first < 30 && sample.second < 30 && sample.marker in 2900.0..3050.0 }
                    retained
                } else {
                    { sample -> sample.first < 30 && sample.marker < 30 && sample.second in (if (tempo == 1f) 8950.0..9050.0 else 8700.0..9300.0) }
                }
                meter.await(stable)
                if (technique == ProgramMixCurve.Technique.DIRECT) {
                    val incomingPosition = java.util.concurrent.atomic.AtomicLong()
                    instrumentation.runOnMainSync { incomingPosition.set(decoders[1].currentPosition) }
                    assertTrue("Direct cut consumed incoming cue ahead of playback", incomingPosition.get() < 1500)
                }
                assertNull("Decoder failed", playbackFailure.get()); assertNull("Output failed", owner.error())
                if (!recoverIncoming) instrumentation.runOnMainSync { decoders.first().release(); decoders.removeAt(0) }
                meter.metrics.clear(); meter.await(stable)
                if (tempo != 1f) {
                    val mediaPosition = java.util.concurrent.atomic.AtomicLong()
                    val actualRate = AtomicReference<PlaybackParameters>()
                    instrumentation.runOnMainSync {
                        mediaPosition.set(decoders.single().currentPosition)
                        actualRate.set(decoders.single().playbackParameters)
                    }
                    assertEquals("Incoming tempo was not retained", tempo.toDouble(), actualRate.get().speed.toDouble(), 0.001)
                    assertEquals("Tempo changed pitch", 1.0, actualRate.get().pitch.toDouble(), 0.001)
                    val expected = owner.inputPositionUs(1) / 1000.0 * tempo
                    assertTrue("Incoming media clock did not track software tempo", abs(mediaPosition.get() - expected) < 120)
                    assertTrue("Tempo clock unexpectedly remained at normal speed", mediaPosition.get() > owner.inputPositionUs(1) / 1000.0 + 50)
                }
                if (returnTempo) {
                    val incoming = decoders.single()
                    val epoch = owner.epoch()
                    val currentRate = AtomicReference(tempo)
                    instrumentation.runOnMainSync {
                        rateReturn = ProgramRateReturn(Handler(Looper.getMainLooper()),
                            { owns() && owner.epoch() == epoch && decoders.contains(incoming) }, owner::positionUs,
                            { rate -> incoming.playbackParameters = PlaybackParameters(rate, 1f); currentRate.set(rate) })
                        rateReturn!!.start(tempo)
                    }
                    Thread.sleep(1000)
                    assertTrue("Tempo return did not begin", currentRate.get() < tempo && currentRate.get() > 1f)
                    owner.pause(true)
                    Thread.sleep(300)
                    val heldRate = currentRate.get()
                    Thread.sleep(500)
                    assertEquals("Paused programme advanced its tempo ramp", heldRate.toDouble(), currentRate.get().toDouble(), 0.0002)
                    owner.pause(false)
                    val returnDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
                    while (currentRate.get() != 1f && System.nanoTime() < returnDeadline) Thread.sleep(50)
                    assertEquals("Tempo did not return to normal", 1.0, currentRate.get().toDouble(), 0.0001)
                    meter.metrics.clear(); meter.await(stable)
                    instrumentation.runOnMainSync {
                        assertEquals("Returned tempo changed pitch", 1.0, incoming.playbackParameters.pitch.toDouble(), 0.001)
                    }
                }
                owner.pause(true)
                Thread.sleep(200)
                val pausedPosition = owner.positionUs()
                Thread.sleep(300)
                assertTrue("Physical output clock moved while paused", abs(pausedPosition - owner.positionUs()) <= 2000L)
                owner.pause(false)
                meter.metrics.clear(); meter.await(stable)
                val resumeDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (owner.positionUs() <= pausedPosition && System.nanoTime() < resumeDeadline) Thread.sleep(20)
                assertTrue("Physical output did not resume", owner.positionUs() > pausedPosition)
                cleanFixture(connection, origin)
                connection.clearSession(true)
                val cancelDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (owner.error() == null && System.nanoTime() < cancelDeadline) Thread.sleep(20)
                assertNotNull("Output continued after scope invalidation", owner.error())
                Thread.sleep(200); val revokedPosition = owner.positionUs()
                Thread.sleep(300)
                assertTrue("Revoked output clock moved", abs(revokedPosition - owner.positionUs()) <= 2000L)
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"))
            }
        } finally {
            instrumentation.runOnMainSync { rateReturn?.close(); decoders.forEach { it.release() } }; mix?.close()
            audioClient?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() }
            try {
                cleanFixture(connection, origin)
            } finally { connection.clearSession(true) }
        }
    }
    private fun cleanFixture(connection: EngineConnection, origin: String?) {
    if (connection.cookieHeader(connection.generation) != null) {
        val clean = connection.client.newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Cookie", connection.cookieHeader(connection.generation) ?: "").build()) }.build()
        clean.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
            .post("{\"measured\":false}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
        for (id in listOf("member-pcm-soft", "member-pcm-loud")) {
            clean.newCall(okhttp3.Request.Builder().url(origin + "/api/library/tracks/" + id).delete().build()).execute().use { assertEquals(200, it.code) }
        }
    }
    }

}
