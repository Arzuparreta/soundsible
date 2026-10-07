package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class ProgramDeckEffectsTest {
    private fun amplitude(frequency: Double, low: Double, cutoff: Double): Double {
        val effects = ProgramDeckEffects(48000, 1); effects.configure(low, cutoff)
        val input = FloatArray(1); val output = FloatArray(1); var energy = 0.0
        for (frame in 0 until 48000) {
            input[0] = (0.1 * sin(2 * Math.PI * frequency * frame / 48000)).toFloat()
            effects.frame(input, 0, output, 0, 1.0, 1.0, 0.0)
            if (frame >= 24000) energy += output[0] * output[0]
            assertTrue(output[0].isFinite())
        }
        return sqrt(energy / 24000) * sqrt(2.0)
    }
    @Test fun bassSwapSuppressesBassWhileKeepingTreble() {
        assertTrue(amplitude(80.0, -18.0, 24000.0) < 0.02)
        assertEquals(0.1, amplitude(4400.0, -18.0, 24000.0), 0.002)
    }
    @Test fun filterSuppressesHighFrequencyWhileKeepingBass() {
        assertTrue(amplitude(4400.0, 0.0, 700.0) < 0.004)
        assertEquals(0.1, amplitude(80.0, 0.0, 700.0), 0.002)
    }
    @Test fun lowpassResonanceMatchesWebAudioDecibelQ() {
        // At cutoff the normative transfer magnitude is 10^(Q_dB/20).
        // A linear Q=0.7 implementation would incorrectly produce 0.07 here.
        assertEquals(0.1 * 10.0.pow(0.7 / 20), amplitude(700.0, 0.0, 700.0), 0.0002)
    }
    @Test fun echoIsLevelledBeforeDryGainAndResetRemovesPriorScope() {
        val effects = ProgramDeckEffects(10000, 2); effects.configure(0.0, 5000.0)
        val input = floatArrayOf(0.5f, -0.5f); val output = FloatArray(2)
        effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
        input.fill(0f)
        repeat(2799) { effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32); assertEquals(0f, output[0], 0f) }
        effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
        assertEquals(0.08f, output[0], 1e-6f); assertEquals(-0.08f, output[1], 1e-6f)
        effects.reset()
        repeat(5600) { effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32); assertArrayEquals(floatArrayOf(0f, 0f), output, 0f) }
    }
}
