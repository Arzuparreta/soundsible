package com.soundsible.android

import kotlin.math.*

/** Stereo-linked blend protection after summed effects, before output volume/capture. */
internal class ProgramMixLimiter(private val rate: Int) {
    init { require(rate in 8000..192000) }
    private var threshold = 0.0
    private var target = 0.0
    private var remaining = 0
    private var step = 0.0
    private var gain = 1.0
    private val attack = exp(-1.0 / (rate * 0.003))
    private val release = exp(-1.0 / (rate * 0.18))
    fun blend(active: Boolean) {
        val next = if (active) -6.0 else 0.0
        if (next != target) {
            target = next; remaining = (rate * 0.25).roundToInt(); step = (target - threshold) / remaining
        }
    }
    fun frame(samples: DoubleArray, channels: Int) {
        require(channels in 1..8 && samples.size >= channels && (0 until channels).all { samples[it].isFinite() })
        if (remaining > 0) { threshold += step; if (--remaining == 0) threshold = target }
        val peak = (0 until channels).maxOf { abs(samples[it]) }
        val level = if (peak > 0) 20 * log10(peak) else -200.0
        val difference = level - threshold
        val reduction = when {
            difference <= -4 -> 0.0
            difference >= 4 -> (1.0 / 6 - 1) * difference
            else -> (1.0 / 6 - 1) * (difference + 4).pow(2) / 16
        }
        val desired = 10.0.pow(reduction / 20)
        val smoothing = if (desired < gain) attack else release
        gain = desired + smoothing * (gain - desired)
        repeat(channels) { samples[it] = (samples[it] * gain).coerceIn(-1.0, 1.0) }
    }
    fun reset() { threshold = 0.0; target = 0.0; remaining = 0; step = 0.0; gain = 1.0 }
}
