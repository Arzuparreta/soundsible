package com.soundsible.android

import kotlin.math.*

/** Per-decoder filters and bounded echo delay; inputs are normalized PCM floats. */
internal class ProgramDeckEffects(private val rate: Int, private val channels: Int) {
    init { require(rate in 8000..192000 && channels in 1..8) }
    private class Filter(channels: Int) {
        private val z1 = DoubleArray(channels); private val z2 = DoubleArray(channels)
        var b0 = 1.0; var b1 = 0.0; var b2 = 0.0; var a1 = 0.0; var a2 = 0.0
        fun coefficients(b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double) {
            this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0
        }
        fun sample(value: Double, channel: Int): Double {
            val output = b0 * value + z1[channel]
            z1[channel] = b1 * value - a1 * output + z2[channel]
            z2[channel] = b2 * value - a2 * output
            return output
        }
        fun reset() { z1.fill(0.0); z2.fill(0.0) }
    }
    private val low = Filter(channels); private val filter = Filter(channels)
    private val delay = DoubleArray((rate * 0.28).roundToInt() * channels)
    private var delayFrame = 0
    private var lowDb = 0.0; private var cutoff = rate.toDouble() / 2
    private var lowActive = false; private var filterActive = false
    fun configure(lowDb: Double, cutoff: Double) {
        require(lowDb.isFinite() && lowDb in -24.0..6.0 && cutoff.isFinite() && cutoff > 0)
        if (this.lowDb != lowDb) {
            this.lowDb = lowDb; lowActive = lowDb != 0.0
            if (!lowActive) low.reset()
            val amplitude = 10.0.pow(lowDb / 40); val w = 2 * Math.PI * 220 / rate
            val c = cos(w); val alpha = sin(w) / sqrt(2.0); val root = 2 * sqrt(amplitude) * alpha
            low.coefficients(amplitude * ((amplitude + 1) - (amplitude - 1) * c + root),
                2 * amplitude * ((amplitude - 1) - (amplitude + 1) * c),
                amplitude * ((amplitude + 1) - (amplitude - 1) * c - root),
                (amplitude + 1) + (amplitude - 1) * c + root,
                -2 * ((amplitude - 1) + (amplitude + 1) * c),
                (amplitude + 1) + (amplitude - 1) * c - root)
        }
        val frequency = cutoff.coerceAtMost(rate * 0.49)
        if (this.cutoff != frequency) {
            this.cutoff = frequency; filterActive = cutoff < rate * 0.49
            if (!filterActive) filter.reset()
            // Web Audio lowpass Q is expressed in dB, unlike the linear RBJ quality factor.
            // Match graph.ts Q.value=0.7 using the normative Web Audio coefficients.
            val w = 2 * Math.PI * frequency / rate; val c = cos(w)
            val alpha = sin(w) / (2 * 10.0.pow(0.7 / 20))
            filter.coefficients((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha)
        }
    }
    /** Echo taps the levelled signal before the dry crossfade, matching the shared graph. */
    fun frame(input: FloatArray, offset: Int, output: FloatArray, outputOffset: Int,
        level: Double, dryGain: Double, echoWet: Double) {
        require(level.isFinite() && level in 0.05..4.0 && dryGain.isFinite() && dryGain in 0.0..1.0 && echoWet.isFinite() && echoWet in 0.0..0.5)
        require(offset >= 0 && outputOffset >= 0 && offset + channels <= input.size && outputOffset + channels <= output.size)
        require((0 until channels).all { input[offset + it].isFinite() })
        repeat(channels) { channel ->
            var value = input[offset + channel].toDouble()
            if (lowActive) value = low.sample(value, channel)
            if (filterActive) value = filter.sample(value, channel)
            value *= level
            val delayed = delay[delayFrame + channel]
            delay[delayFrame + channel] = value + delayed * 0.32
            output[outputOffset + channel] = (value * dryGain + delayed * echoWet).toFloat()
        }
        delayFrame += channels; if (delayFrame == delay.size) delayFrame = 0
    }
    fun reset() { low.reset(); filter.reset(); delay.fill(0.0); delayFrame = 0 }
}
