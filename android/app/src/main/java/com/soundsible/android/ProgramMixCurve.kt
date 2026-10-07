package com.soundsible.android

import kotlin.math.cos
import kotlin.math.sin

/** Sample-clock automation; never driven by Activity timers. */
internal object ProgramMixCurve {
    enum class Technique { DIRECT, SAFE_FADE, STRUCTURAL_FADE, BASS_SWAP, FILTER_BLEND, LONG_BLEND, ECHO_CUT }
    data class Controls(val outgoing: Double, val incoming: Double, val outgoingLowDb: Double,
        val incomingLowDb: Double, val outgoingCutoff: Double, val incomingCutoff: Double, val echoWet: Double)
    private fun curve(progress: Double, points: DoubleArray): Double {
        val position = progress.coerceIn(0.0, 1.0) * (points.size - 1)
        val index = position.toInt().coerceAtMost(points.size - 2)
        return points[index] + (points[index + 1] - points[index]) * (position - index)
    }
    private val outLow = doubleArrayOf(0.0, 0.0, -4.0, -12.0, -18.0, -18.0)
    private val inLow = doubleArrayOf(-18.0, -18.0, -12.0, -4.0, 0.0, 0.0)
    private val outFilter = doubleArrayOf(22000.0, 18000.0, 9000.0, 3500.0, 1200.0, 700.0)
    private val inFilter = doubleArrayOf(900.0, 1600.0, 4200.0, 10000.0, 18000.0, 22000.0)
    private val echo = doubleArrayOf(0.0, 0.05, 0.12, 0.24, 0.32, 0.18)
    fun at(technique: Technique, progress: Double): Controls {
        require(progress.isFinite())
        val p = progress.coerceIn(0.0, 1.0)
        val direct = technique == Technique.DIRECT
        val low = technique == Technique.BASS_SWAP || technique == Technique.LONG_BLEND
        val filter = technique == Technique.FILTER_BLEND || technique == Technique.LONG_BLEND
        return Controls(if (direct) if (p < 1.0) 1.0 else 0.0 else cos(p * Math.PI / 2),
            if (direct) if (p < 1.0) 0.0 else 1.0 else sin(p * Math.PI / 2),
            if (low) curve(p, outLow) else 0.0, if (low) curve(p, inLow) else 0.0,
            if (filter) curve(p, outFilter) else 22000.0, if (filter) curve(p, inFilter) else 22000.0,
            if (technique == Technique.ECHO_CUT) curve(p, echo) else 0.0)
    }
}
