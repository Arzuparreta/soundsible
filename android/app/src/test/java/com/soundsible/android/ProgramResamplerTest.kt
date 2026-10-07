package com.soundsible.android

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Test

@UnstableApi
class ProgramResamplerTest {
    @Test fun retainsProgrammeRateAfterDecoderReset() {
        val processor = ProgramResampler()
        for (rate in listOf(16000, 48000, 16000)) {
            assertEquals(48000, processor.configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_16BIT)).sampleRate)
            processor.flush()
            processor.reset()
        }
    }
}
