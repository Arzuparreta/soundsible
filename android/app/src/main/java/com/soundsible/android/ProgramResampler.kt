package com.soundsible.android

import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi

/** Sonic resets its target on stop; every new stream must keep the programme format. */
@UnstableApi
internal class ProgramResampler(private val sonic: SonicAudioProcessor = SonicAudioProcessor()) : AudioProcessor by sonic {
    override fun flush() { sonic.flush(AudioProcessor.StreamMetadata.DEFAULT) }
    override fun flush(streamMetadata: AudioProcessor.StreamMetadata) { sonic.flush(streamMetadata) }
    override fun getDurationAfterProcessorApplied(durationUs: Long): Long = sonic.getDurationAfterProcessorApplied(durationUs)
    override fun configure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        sonic.setOutputSampleRateHz(48000)
        return sonic.configure(inputAudioFormat)
    }
}
