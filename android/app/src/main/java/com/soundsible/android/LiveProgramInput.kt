package com.soundsible.android

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import org.webrtc.audio.WebRtcAudioRecord
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

/** Bounded post-DSP programme PCM, resampled to WebRTC's stereo48k input. */
@UnstableApi
internal class LiveProgramInput(private val connection: EngineConnection) : WebRtcAudioRecord.ProgramInput, AutoCloseable {
    private val epoch = connection.generation
    private val closed = AtomicBoolean()
    private val lock = Any()
    private val ring = ByteArray(48000 * 2 * 2) // At most one second; never unbounded track audio.
    private var head = 0
    private var size = 0
    private val channels = ChannelMixingAudioProcessor()
    private val resampler = SonicAudioProcessor().apply { setOutputSampleRateHz(48000) }
    private var format: Pair<Int, Int>? = null
    private val capture = NativeProgramOutput.subscribe(epoch) { block ->
        if (closed.get() || !NativeProgramOutput.playing || connection.generation != epoch) return@subscribe
        if (format != (block.sampleRate to block.channels)) {
            channels.putChannelMixingMatrix(ChannelMixingMatrix.createForConstantPower(block.channels, 2))
            channels.configure(AudioProcessor.AudioFormat(block.sampleRate, block.channels, C.ENCODING_PCM_16BIT)); channels.flush()
            resampler.configure(AudioProcessor.AudioFormat(block.sampleRate, 2, C.ENCODING_PCM_16BIT)); resampler.flush(AudioProcessor.StreamMetadata.DEFAULT)
            format = block.sampleRate to block.channels
            synchronized(lock) { head = 0; size = 0 }
        }
        var bytes = ByteBuffer.wrap(block.bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (channels.isActive) { channels.queueInput(bytes); bytes = channels.output }
        if (resampler.isActive) { resampler.queueInput(bytes); bytes = resampler.output }
        synchronized(lock) {
            if (closed.get() || !NativeProgramOutput.playing || connection.generation != epoch) return@synchronized
            while (bytes.hasRemaining()) {
                if (size == ring.size) { head = (head + 4) % ring.size; size -= 4 }
                ring[(head + size) % ring.size] = bytes.get(); size++
            }
        }
    }
    val failed get() = capture.failed.get()
    override fun read(destination: ByteArray, sampleRate: Int, channelCount: Int) {
        require(sampleRate == 48000 && channelCount == 2)
        synchronized(lock) {
            if (closed.get() || connection.generation != epoch || !NativeProgramOutput.playing) { head = 0; size = 0; return }
            val count = minOf(size, destination.size)
            for (index in 0 until count) { destination[index] = ring[head]; head = (head + 1) % ring.size }
            size -= count
        }
    }
    override fun close() {
        if (closed.compareAndSet(false, true)) {
            WebRtcAudioRecord.detach(this); capture.close()
            synchronized(lock) { head = 0; size = 0 }
        }
    }
}
