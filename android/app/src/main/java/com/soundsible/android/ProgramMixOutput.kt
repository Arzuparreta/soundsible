package com.soundsible.android

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioOutput
import androidx.media3.exoplayer.audio.AudioOutputProvider
import androidx.media3.exoplayer.audio.AudioTrackAudioOutputProvider
import androidx.media3.exoplayer.audio.ForwardingAudioOutput
import androidx.media3.exoplayer.audio.ForwardingAudioOutputProvider
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import kotlin.math.roundToInt

/** Spike: two bounded decoded inputs and exactly one device output. Not wired to the service yet. */
@UnstableApi
internal class ProgramMixOutput(context: Context, private val owns: () -> Boolean,
    private val observe: (ByteArray, Int, Int, Long) -> Unit) : AutoCloseable {
    private val decodingThread = HandlerThread("soundsible-mix-decoders").apply { isDaemon = true; start() }
    val playbackLooper: Looper = decodingThread.looper
    private val decodingHandler = Handler(playbackLooper)
    private val deviceReleased = CountDownLatch(1)
    private val provider = AudioTrackAudioOutputProvider.Builder(context).build()
    private val lock = Object()
    private val deviceLock = Any()
    private var output: AudioOutput? = null
    private var config: AudioOutputProvider.OutputConfig? = null
    private val sources = arrayOfNulls<Source>(2)
    @Volatile private var closed = false
    @Volatile private var outputEpoch = 0L
    // End of reserved output, including the batch currently being written.
    private var frames = 0L
    private var mixStart = Long.MAX_VALUE
    private var mixLength = 1L
    private var technique = ProgramMixCurve.Technique.SAFE_FADE
    private var active = 0
    private var window: ProgramMixWindow? = null
    private var restoration: Pair<Long, Int>? = null
    private var recovery: Recovery? = null
    private data class Recovery(val start: Long, val length: Long, val controls: ProgramMixCurve.Controls) {
        fun at(frame: Long): ProgramMixCurve.Controls {
            val progress = ((frame - start).toDouble() / length).coerceIn(0.0, 1.0)
            return ProgramMixCurve.Controls(controls.outgoing + (1 - controls.outgoing) * progress, 0.0,
                controls.outgoingLowDb * (1 - progress), 0.0,
                controls.outgoingCutoff + (22000 - controls.outgoingCutoff) * progress, 22000.0,
                controls.echoWet * (1 - progress))
        }
    }
    private var limiter: ProgramMixLimiter? = null
    private var paused = false
    private var failure: Throwable? = null
    private val worker = Thread({ render() }, "soundsible-mix-output").apply { isDaemon = true; start() }
    fun input(index: Int): AudioOutputProvider {
        require(index in 0..1)
        return object : ForwardingAudioOutputProvider(provider) {
            override fun getFormatSupport(config: AudioOutputProvider.FormatConfig): AudioOutputProvider.FormatSupport {
                if (config.format.sampleMimeType != androidx.media3.common.MimeTypes.AUDIO_RAW || config.enableOffload || config.enableTunneling) return AudioOutputProvider.FormatSupport.UNSUPPORTED
                return super.getFormatSupport(config)
            }
            override fun getAudioOutput(config: AudioOutputProvider.OutputConfig): AudioOutput = synchronized(lock) {
                require(!closed && owns() && config.encoding == C.ENCODING_PCM_16BIT && !config.isOffload && !config.isTunneling)
                val current = this@ProgramMixOutput.config
                if (current == null) {
                    this@ProgramMixOutput.config = config
                    output = provider.getAudioOutput(config).also { device ->
                        device.addListener(object : AudioOutput.Listener {
                            override fun onPositionAdvancing(playoutStartSystemTimeMs: Long) {}
                            override fun onOffloadDataRequest() {}
                            override fun onOffloadPresentationEnded() {}
                            override fun onUnderrun() {}
                            override fun onReleased() { deviceReleased.countDown() }
                        })
                    }
                    limiter = ProgramMixLimiter(config.sampleRate)
                } else require(current.sampleRate == config.sampleRate && current.channelMask == config.channelMask && current.encoding == config.encoding)
                sources[index]?.let { previous ->
                    if (index == active && !previous.released) invalidateDevice()
                    previous.released = true; previous.queue.clear(); previous.queued = 0
                }
                Source(index, output!!).also { sources[index] = it; lock.notifyAll() }
            }
            override fun release() { /* The shared owner, not a deck, releases the device. */ }
        }
    }
    fun blend(lengthMs: Long, value: ProgramMixCurve.Technique) = synchronized(lock) {
        require(lengthMs in 50..30000 && sources.all { it != null } && mixStart == Long.MAX_VALUE)
        val rate = config!!.sampleRate
        require(recovery == null) { "Current input is recovering" }
        val incoming = sources[1 - active]!!
        require(!incoming.released && incoming.playing && incoming.queued > 0) { "Incoming input not ready" }
        restoration = null
        incoming.joinedAt = frames; technique = value
        if (value == ProgramMixCurve.Technique.DIRECT) {
            window = ProgramMixWindow(frames, 0, active, 1 - active, outputEpoch)
            active = 1 - active; limiter?.blend(false)
        } else {
            mixStart = frames; mixLength = lengthMs * rate / 1000; technique = value
            window = ProgramMixWindow(mixStart, mixLength, active, 1 - active, outputEpoch)
        }
        lock.notifyAll()
    }
    fun pause(value: Boolean) = synchronized(lock) {
        paused = value; synchronized(deviceLock) { if (value) output?.pause() else output?.play() }; lock.notifyAll()
    }
    fun setVolume(value: Float) = synchronized(lock) { require(value.isFinite() && value in 0f..1f); synchronized(deviceLock) { output?.setVolume(value) } }
    fun error(): Throwable? = synchronized(lock) { failure }
    fun transition(): ProgramMixWindow? = synchronized(lock) { window }
    fun dominantInput(): Int = synchronized(lock) {
        val current = window?.takeIf { it.epoch == outputEpoch }
        val played = positionUs() * (config?.sampleRate ?: 0) / 1000000
        restoration?.takeIf { played >= it.first }?.second ?: current?.dominant(played) ?: active
    }
    fun restoredAt(): Long? = synchronized(lock) { restoration?.first }
    fun epoch(): Long = outputEpoch
    fun positionUs(): Long = synchronized(deviceLock) { output?.positionUs ?: 0L }
    /** Called with the state lock; covers flush, release and input replacement on seek. */
    private fun invalidateDevice() {
        outputEpoch++
        synchronized(deviceLock) { output?.pause(); output?.flush() }
        frames = 0L; mixStart = Long.MAX_VALUE; window = null; restoration = null; recovery = null; limiter?.reset()
        sources.forEachIndexed { index, source -> source?.let {
            it.joinedAt = if (index == active) 0L else Long.MAX_VALUE
            it.effects.reset()
        } }
    }
    /** Losing an incoming deck restores the retained outgoing PCM without flushing the programme. */
    private fun recoverIncoming(index: Int): Boolean {
        val transition = window?.takeIf { it.epoch == outputEpoch && it.incoming == index } ?: return false
        val outgoing = sources[transition.outgoing]?.takeIf { !it.released && it.playing && !(it.ended && it.queued == 0) } ?: return false
        val progress = if (transition.length == 0L) 1.0 else (frames - transition.start).toDouble() / transition.length
        val controls = ProgramMixCurve.at(technique, progress)
        if (active != transition.outgoing) outgoing.joinedAt = frames - outgoing.supplied
        active = transition.outgoing; mixStart = Long.MAX_VALUE
        recovery = Recovery(frames, (config!!.sampleRate * 0.15).toLong(), controls)
        restoration = frames to active
        limiter?.blend(false); lock.notifyAll()
        return true
    }
    private inner class Source(val index: Int, device: AudioOutput) : ForwardingAudioOutput(device) {
        val queue = ArrayDeque<ByteBuffer>()
        var queued = 0
        var joinedAt = if (index == active) frames else Long.MAX_VALUE
        var supplied = 0L
        var playing = false
        var released = false
        var ended = false
        val effects = ProgramDeckEffects(config!!.sampleRate, Integer.bitCount(config!!.channelMask))
        var level = 1.0
        private val listeners = mutableSetOf<AudioOutput.Listener>()
        override fun write(buffer: ByteBuffer, encodedAccessUnitCount: Int, presentationTimeUs: Long): Boolean = synchronized(lock) {
            check(!closed && !released && failure == null && owns())
            val channels = Integer.bitCount(config!!.channelMask)
            val bytesPerFrame = channels * 2
            require(buffer.remaining() % bytesPerFrame == 0)
            val capacity = config!!.sampleRate / 5 * bytesPerFrame
            val count = minOf(buffer.remaining(), capacity - queued) / bytesPerFrame * bytesPerFrame
            if (count > 0) {
                val copy = ByteBuffer.allocateDirect(count).order(ByteOrder.LITTLE_ENDIAN)
                val view = buffer.duplicate(); view.limit(view.position() + count)
                copy.put(view).flip(); buffer.position(buffer.position() + count)
                queue.add(copy); queued += count; lock.notifyAll()
            }
            !buffer.hasRemaining()
        }
        fun read(target: ShortArray, count: Int) {
            repeat(count) { sample ->
                val head = queue.first(); target[sample] = head.short
                queued -= 2; if (!head.hasRemaining()) queue.removeFirst()
            }
            supplied += count / Integer.bitCount(config!!.channelMask)
        }
        override fun play() = synchronized(lock) { playing = true; if (index == active && !paused) synchronized(deviceLock) { output?.play() }; lock.notifyAll() }
        override fun pause() = synchronized(lock) { playing = false; if (index == active) synchronized(deviceLock) { output?.pause() }; lock.notifyAll() }
        override fun flush() = synchronized(lock) {
            queue.clear(); queued = 0; supplied = 0; ended = false; effects.reset()
            if (index == active) {
                invalidateDevice()
                if (playing && !paused) synchronized(deviceLock) { output?.play() }
            } else joinedAt = Long.MAX_VALUE
            lock.notifyAll()
        }
        override fun stop() = synchronized(lock) { ended = true; lock.notifyAll() }
        override fun release() = synchronized(lock) {
            if (!released) {
                released = true; queue.clear(); queued = 0
                val recovered = !closed && recoverIncoming(index)
                if (index == active && !closed && !recovered) invalidateDevice()
                listeners.forEach { it.onReleased() }
            }
            lock.notifyAll()
        }
        override fun getPositionUs(): Long = synchronized(lock) {
            if (joinedAt == Long.MAX_VALUE) 0L else {
                val played = (positionUs() * config!!.sampleRate / 1000000 - joinedAt).coerceIn(0, supplied)
                played * 1000000 / config!!.sampleRate
            }
        }
        override fun setVolume(volume: Float) { /* Local volume belongs to the programme owner. */ }
        override fun setPlaybackParameters(playbackParams: PlaybackParameters) { require(playbackParams == PlaybackParameters.DEFAULT) }
        override fun getPlaybackParameters() = PlaybackParameters.DEFAULT
        override fun addListener(listener: AudioOutput.Listener) = synchronized(lock) { listeners.add(listener); Unit }
        override fun removeListener(listener: AudioOutput.Listener) = synchronized(lock) { listeners.remove(listener); Unit }
        override fun isStalled() = false
        override fun isOffloadedPlayback() = false
    }
    private data class Batch(val buffer: ByteBuffer, val rate: Int, val channels: Int, val start: Long, val epoch: Long)
    private fun render() {
        try {
            while (true) {
                val batch = synchronized(lock) {
                    while (!closed) {
                        check(owns()) { "Programme ownership changed" }
                        val source = sources[active]
                        val format = config
                        val channels = format?.let { Integer.bitCount(it.channelMask) } ?: 0
                        val fullCount = (format?.sampleRate ?: 0) / 100 * channels
                        val count = if (source?.ended == true) minOf(fullCount, source.queued / 2) else fullCount
                        val mixing = frames >= mixStart && frames < mixStart + mixLength
                        val incoming = sources[1 - active]
                        if (!paused && source?.playing == true && count > 0 && source.queued >= count * 2 && (!mixing || incoming?.playing == true && incoming.queued >= count * 2)) {
                            val first = ShortArray(count); source.read(first, count)
                            val second = if (mixing) ShortArray(count).also { incoming!!.read(it, count) } else null
                            val result = ByteBuffer.allocateDirect(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                            val firstFrame = FloatArray(channels); val secondFrame = FloatArray(channels)
                            val firstEffect = FloatArray(channels); val secondEffect = FloatArray(channels)
                            val mixed = DoubleArray(channels)
                            limiter!!.blend(mixing)
                            repeat(count / channels) { frame ->
                                val gains = if (mixing) ProgramMixCurve.at(technique, (frames + frame - mixStart).toDouble() / mixLength) else recovery?.at(frames + frame)
                                if (frame % 48 == 0) {
                                    source.effects.configure(gains?.outgoingLowDb ?: 0.0, gains?.outgoingCutoff ?: 22000.0)
                                    if (mixing) incoming!!.effects.configure(gains!!.incomingLowDb, gains.incomingCutoff)
                                }
                                repeat(channels) { channel ->
                                    val index = frame * channels + channel
                                    firstFrame[channel] = first[index] / 32768f
                                    secondFrame[channel] = (second?.get(index)?.toInt() ?: 0) / 32768f
                                }
                                source.effects.frame(firstFrame, 0, firstEffect, 0, source.level, gains?.outgoing ?: 1.0, gains?.echoWet ?: 0.0)
                                if (mixing) incoming!!.effects.frame(secondFrame, 0, secondEffect, 0, incoming.level, gains!!.incoming, 0.0)
                                repeat(channels) { channel -> mixed[channel] = firstEffect[channel].toDouble() + if (mixing) secondEffect[channel] else 0f }
                                limiter!!.frame(mixed, channels)
                                repeat(channels) { channel -> result.putShort((mixed[channel] * 32768).roundToInt().coerceIn(-32768, 32767).toShort()) }
                            }
                            result.flip()
                            val start = frames
                            frames += count / channels
                            return@synchronized Batch(result, format!!.sampleRate, channels, start, outputEpoch)
                        }
                        lock.wait(10)
                    }
                    null
                } ?: return
                val copy = ByteArray(batch.buffer.remaining()); batch.buffer.duplicate().get(copy)
                val device = output ?: error("Output owner disappeared")
                check(owns()) { "Programme ownership changed" }
                while (!closed && batch.epoch == outputEpoch) {
                    val accepted = synchronized(deviceLock) {
                        if (closed || batch.epoch != outputEpoch) false
                        else device.write(batch.buffer, 1, batch.start * 1000000 / batch.rate)
                    }
                    if (accepted) break
                    synchronized(lock) { if (closed) return; check(owns()) }
                    Thread.sleep(1)
                }
                if (closed || batch.epoch != outputEpoch) continue
                if (owns()) observe(copy, batch.rate, batch.channels, batch.start)
                synchronized(lock) {
                    if (batch.epoch == outputEpoch && mixStart != Long.MAX_VALUE && frames >= mixStart + mixLength) {
                        active = 1 - active; mixStart = Long.MAX_VALUE
                    }
                    recovery?.takeIf { batch.epoch == outputEpoch && frames >= it.start + it.length }?.let { recovery = null }
                    lock.notifyAll()
                }
            }
        } catch (_: InterruptedException) { /* Explicit owner close. */ }
        catch (problem: Throwable) {
            synchronized(lock) { failure = problem; sources.forEach { it?.queue?.clear(); it?.queued = 0 }; synchronized(deviceLock) { output?.pause(); output?.flush() }; lock.notifyAll() }
        }
    }
    override fun close() {
        synchronized(lock) { if (closed) return; closed = true; synchronized(deviceLock) { output?.pause(); output?.flush() }; sources.forEach { it?.queue?.clear(); it?.queued = 0 }; lock.notifyAll() }
        check(Looper.myLooper() != playbackLooper) { "Close the mix owner outside its decoder looper" }
        worker.interrupt(); worker.join(1000)
        val cleanup = CountDownLatch(1)
        decodingHandler.post {
            try {
                val device = output
                if (device == null) deviceReleased.countDown() else synchronized(deviceLock) { device.release() }
                provider.release()
            } finally { cleanup.countDown() }
        }
        check(cleanup.await(3, TimeUnit.SECONDS)) { "Mix resources did not release" }
        check(deviceReleased.await(3, TimeUnit.SECONDS)) { "Mix device did not release" }
        decodingThread.quitSafely(); decodingThread.join(1000)
    }
}
