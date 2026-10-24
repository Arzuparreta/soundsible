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
        effects.configureEcho(0.5)
        val input = floatArrayOf(0.5f, -0.5f); val output = FloatArray(2)
        effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
        input.fill(0f)
        repeat(4999) { effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32); assertEquals(0f, output[0], 0f) }
        effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
        assertEquals(0.08f, output[0], 1e-6f); assertEquals(-0.08f, output[1], 1e-6f)
        effects.reset()
        repeat(10000) { effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32); assertArrayEquals(floatArrayOf(0f, 0f), output, 0f) }
    }
    @Test fun sharedServerEchoPlansRepeatImpulsesAtTheMeasuredBeatOnEachSampleClock() {
        val vectors = javaClass.classLoader!!.getResourceAsStream("dj_echo_plans.json")!!.bufferedReader().use { org.json.JSONArray(it.readText()) }
        for (index in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(index)
            val seconds = vector.getJSONObject("transition").getDouble("echo_delay_seconds")
            for (rate in listOf(44100, 48000)) for (speed in listOf(1.0, 1.04)) {
                val effects = ProgramDeckEffects(rate, 2)
                effects.configureEcho(seconds / speed)
                val period = (rate * 60 / vector.getDouble("bpm") / speed).roundToInt()
                val input = floatArrayOf(0.5f, -0.5f); val output = FloatArray(2)
                effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
                input.fill(0f)
                for (frame in 1..(period * 3)) {
                    effects.frame(input, 0, output, 0, 0.5, 0.0, 0.32)
                    val expected = if (frame % period == 0) (0.08 * 0.32.pow(frame / period - 1)).toFloat() else 0f
                    assertEquals("${vector.getString("name")} rate=$rate speed=$speed frame=$frame", expected, output[0], 1e-6f)
                    assertEquals(-expected, output[1], 1e-6f)
                }
            }
        }
    }
    @Test fun changingOrRemovingDelayClearsThePreviousTail() {
        val effects = ProgramDeckEffects(10000, 1)
        val input = floatArrayOf(0.5f); val output = FloatArray(1)
        effects.configureEcho(0.5)
        effects.frame(input, 0, output, 0, 1.0, 0.0, 0.32)
        input.fill(0f)
        effects.configureEcho(0.375)
        repeat(10000) { effects.frame(input, 0, output, 0, 1.0, 0.0, 0.32); assertEquals(0f, output[0], 0f) }
        effects.configureEcho(null)
        input[0] = 0.5f
        repeat(10000) { effects.frame(input, 0, output, 0, 1.0, 0.0, 0.32); assertEquals(0f, output[0], 0f) }
    }
}
