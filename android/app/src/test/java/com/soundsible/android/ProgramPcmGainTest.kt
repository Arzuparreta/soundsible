package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class ProgramPcmGainTest {
    private fun input(vararg values: Int) = ByteBuffer.allocate(values.size * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
        values.forEach { putShort(it.toShort()) }; flip()
    }
    private fun output(samples: Int) = ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN)
    @Test fun unityAndResetPreserveSignedSamplesExactly() {
        val processor = ProgramPcmGain(); val target = output(7)
        processor.process(input(-32768, -12345, -1, 0, 1, 12345, 32767), target, 1.0, 48000, 1)
        target.flip(); assertArrayEquals(intArrayOf(-32768, -12345, -1, 0, 1, 12345, 32767), IntArray(7) { target.short.toInt() })
        processor.reset(0.5); val half = output(2); processor.process(input(-20000, 20000), half, 0.5, 48000, 1)
        half.flip(); assertEquals(-10000, half.short.toInt()); assertEquals(10000, half.short.toInt())
        processor.reset(); val restored = output(1); processor.process(input(12345), restored, 1.0, 48000, 1)
        restored.flip(); assertEquals(12345, restored.short.toInt())
    }
    @Test fun stereoPreferenceRampUsesFramesAndContinuesAcrossBuffers() {
        val processor = ProgramPcmGain()
        val first = output(10); processor.process(input(*IntArray(10) { 20000 }), first, 0.5, 1000, 2)
        first.flip(); repeat(5) { index -> val expected = 19000 - index * 1000; assertEquals(expected, first.short.toInt()); assertEquals(expected, first.short.toInt()) }
        val second = output(12); processor.process(input(*IntArray(12) { 20000 }), second, 0.5, 1000, 2)
        second.flip(); repeat(6) { index -> val expected = (14000 - index * 1000).coerceAtLeast(10000); assertEquals(expected, second.short.toInt()); assertEquals(expected, second.short.toInt()) }
    }
    @Test fun amplificationSaturatesAndInvalidGainCannotMute() {
        val processor = ProgramPcmGain(); processor.reset(4.0)
        val clipped = output(3); processor.process(input(-30000, 0, 30000), clipped, 4.0, 48000, 1)
        clipped.flip(); assertEquals(-32768, clipped.short.toInt()); assertEquals(0, clipped.short.toInt()); assertEquals(32767, clipped.short.toInt())
        for (invalid in listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, -1.0, 10.0)) {
            processor.reset(invalid); val restored = output(1); processor.process(input(3000), restored, invalid, 48000, 1)
            restored.flip(); assertEquals(3000, restored.short.toInt())
        }
    }
    @Test fun malformedInterleavedFrameIsRejectedBeforeConsumingInput() {
        val processor = ProgramPcmGain(); val odd = input(100, 100, 100)
        assertThrows(IllegalArgumentException::class.java) { processor.process(odd, output(3), 1.0, 48000, 2) }
        assertEquals(0, odd.position())
    }
}
