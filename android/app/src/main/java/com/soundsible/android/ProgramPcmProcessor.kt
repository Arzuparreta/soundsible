package com.soundsible.android

import androidx.media3.common.C
import androidx.media3.common.Timeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer

/** Actual decoded stream identity comes from the sink flush, never the UI's current item. */
@UnstableApi
internal class ProgramPcmProcessor(
    private val generation: () -> Long,
    private val enabled: () -> Boolean,
    private val shuffle: () -> Boolean,
    private val tap: ProgramPcmTap,
) : BaseAudioProcessor() {
    private val envelope = ProgramPcmGain()
    private var stream: ProgramPcmTap.Stream? = null
    private var facts: ProgramLoudness.Facts? = null
    private var album: ProgramLoudness.Reference? = null
    private var frames = 0L
    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT || inputAudioFormat.channelCount !in 1..32 || inputAudioFormat.sampleRate <= 0) {
            throw AudioProcessor.UnhandledAudioFormatException(inputAudioFormat)
        }
        return inputAudioFormat // Stay active at unity: output capture must still observe the programme.
    }
    override fun onFlush(metadata: AudioProcessor.StreamMetadata) {
        stream = null; facts = null; album = null; frames = 0; tap.discardBuffered()
        val uid = metadata.periodUid
        val timeline = metadata.timeline
        if (uid != null && timeline.getIndexOfPeriod(uid) != C.INDEX_UNSET) {
            val period = timeline.getPeriodByUid(uid, Timeline.Period())
            val item = timeline.getWindow(period.windowIndex, Timeline.Window()).mediaItem
            val extras = item.mediaMetadata.extras
            if (extras != null && extras.getLong(GENERATION, -1) == generation()) {
                val key = extras.getString(ProgramQueue.KEY).orEmpty()
                val program = extras.getString(ProgramQueue.PROGRAM).orEmpty()
                val source = extras.getString(ProgramQueue.SOURCE).orEmpty()
                if (key.isNotEmpty() && program.isNotEmpty()) {
                    stream = ProgramPcmTap.Stream(generation(), key, program, source, metadata.positionOffsetUs)
                    fun number(name: String) = extras.getDouble(name, Double.NaN).takeIf { it.isFinite() }
                    facts = ProgramLoudness.Facts(number(LUFS), number(PEAK), number(DURATION))
                    if (extras.getString(CONTEXT_KIND) == "album" && !extras.getString(CONTEXT_ID).isNullOrEmpty()) {
                        val lufs = number(ALBUM_LUFS); val peak = number(ALBUM_PEAK)
                        if (lufs != null && peak != null) album = ProgramLoudness.Reference(lufs, peak)
                    }
                }
            }
        }
        envelope.reset(gain())
    }
    private fun gain(): Double {
        if (stream?.generation != generation() || !enabled()) return 1.0
        if (!shuffle()) album?.let { return ProgramLoudness.linear(ProgramLoudness.gainDb(it.lufs, it.peakDbtp)) }
        return ProgramLoudness.levelFor(facts, true)
    }
    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining(); if (size == 0) return
        val output = replaceOutputBuffer(size)
        envelope.process(inputBuffer, output, gain(), inputAudioFormat.sampleRate, inputAudioFormat.channelCount)
        output.flip()
        stream?.takeIf { it.generation == generation() }?.let {
            tap.offer(output, inputAudioFormat.sampleRate, inputAudioFormat.channelCount, it, frames)
        }
        frames += size / (inputAudioFormat.channelCount * 2)
    }
    override fun onReset() { stream = null; facts = null; album = null; frames = 0; envelope.reset(); tap.discardBuffered() }
    companion object {
        const val GENERATION = "soundsible_pcm_generation"
        const val LUFS = "soundsible_pcm_lufs"
        const val PEAK = "soundsible_pcm_peak"
        const val DURATION = "soundsible_pcm_duration"
        const val CONTEXT_KIND = "soundsible_pcm_context_kind"
        const val CONTEXT_ID = "soundsible_pcm_context_id"
        const val ALBUM_LUFS = "soundsible_pcm_album_lufs"
        const val ALBUM_PEAK = "soundsible_pcm_album_peak"
    }
}
