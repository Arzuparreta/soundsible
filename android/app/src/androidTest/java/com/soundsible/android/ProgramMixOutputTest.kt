package com.soundsible.android

import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
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
    private data class Spectrum(val start: Long, val first: Double, val second: Double)
    private class Meter {
        val metrics = ArrayBlockingQueue<Spectrum>(32)
        var start = 0L; var count = 0
        val real = DoubleArray(2); val imaginary = DoubleArray(2)
        fun accept(bytes: ByteArray, rate: Int, channels: Int, frame: Long) {
            val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            var offset = 0
            while (input.hasRemaining()) {
                val value = input.short.toDouble(); repeat(channels - 1) { input.short }
                if (count == 0) start = frame + offset
                for (index in 0..1) {
                    val phase = 2 * Math.PI * (if (index == 0) 440 else 880) * (frame + offset) / rate
                    real[index] += value * cos(phase); imaginary[index] -= value * sin(phase)
                }
                count++; offset++
                if (count == rate / 10) {
                    metrics.offer(Spectrum(start, hypot(real[0], imaginary[0]) * 2 / count, hypot(real[1], imaginary[1]) * 2 / count))
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
    private fun run(origin: String?) {
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val connection = EngineConnection.shared(context)
        connection.clearSession(true)
        val decoders = mutableListOf<ExoPlayer>()
        var mix: ProgramMixOutput? = null
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
                client.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                    .post("{\"album\":true,\"secondFrequency\":880,\"secondRate\":48000,\"secondChannels\":2}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                audioClient = client
                val meter = Meter()
                val owner = ProgramMixOutput(context, owns, meter::accept); mix = owner
                instrumentation.runOnMainSync {
                    for ((index, id) in listOf("member-track", "member-pcm-loud").withIndex()) {
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
                        decoder.prepare(); decoder.play(); decoders.add(decoder)
                    }
                }
                meter.await { it.first in 2950.0..3050.0 && it.second < 30 }
                owner.setVolume(0.1f)
                owner.blend(2000, ProgramMixCurve.Technique.SAFE_FADE)
                meter.await { it.first in 1800.0..2400.0 && it.second in 5500.0..7000.0 }
                meter.await { it.first < 30 && it.second in 8950.0..9050.0 }
                assertNull("Decoder failed", playbackFailure.get()); assertNull("Output failed", owner.error())
                instrumentation.runOnMainSync { decoders.first().release(); decoders.removeAt(0) }
                meter.metrics.clear(); meter.await { it.first < 30 && it.second in 8950.0..9050.0 }
                assertEquals("false", web.evaluate(scenario, "!!document.querySelector('audio')"))
            }
        } finally {
            instrumentation.runOnMainSync { decoders.forEach { it.release() } }; mix?.close()
            audioClient?.let { it.dispatcher.cancelAll(); it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() }
            try {
                if (connection.cookieHeader(connection.generation) != null) {
                    val clean = connection.client.newBuilder().addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Cookie", connection.cookieHeader(connection.generation) ?: "").build()) }.build()
                    clean.newCall(okhttp3.Request.Builder().url(origin + "/__fixture/loudness-facts").header("X-Android-Fixture", "isolated")
                        .post("{\"measured\":false}".toRequestBody("application/json".toMediaType())).build()).execute().use { assertEquals(200, it.code) }
                    for (id in listOf("member-pcm-soft", "member-pcm-loud")) {
                        clean.newCall(okhttp3.Request.Builder().url(origin + "/api/library/tracks/" + id).delete().build()).execute().use { assertEquals(200, it.code) }
                    }
                }
            } finally { connection.clearSession(true) }
        }
    }
}
